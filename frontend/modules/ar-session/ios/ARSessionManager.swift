// ARSessionManager.swift
// Singleton that owns the ARSCNView and is shared between
// ARSessionModule (functions) and ARSessionView (native camera view).

import ARKit
import SceneKit

@objc public class ARSessionManager: NSObject {

  @objc public static let shared = ARSessionManager()

  // The ARSCNView is created by ARSessionView and registered here.
  // ARSessionModule reads/writes through this reference.
  public weak var sceneView: ARSCNView?

  // anchor id → ARAnchor — managed by createAnchor / removeAnchor
  public var anchors: [String: ARAnchor] = [:]

  // Callback fired on every ARSession frame — used by ARSessionModule
  // to emit onAnchorPositionsUpdated events
  public var onFrameUpdate: (([String: Any]) -> Void)?

  private override init() { super.init() }

  // MARK: - Session control

  public func startSession() {
    guard ARWorldTrackingConfiguration.isSupported else { return }
    let config = ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal, .vertical]
    config.isAutoFocusEnabled = true
    config.environmentTexturing = .none   // performance: off
    DispatchQueue.main.async {
      self.sceneView?.session.run(config, options: [.removeExistingAnchors])
    }
  }

  public func stopSession() {
    DispatchQueue.main.async {
      self.sceneView?.session.pause()
      self.anchors = [:]
    }
  }

  public func pauseSession() {
    DispatchQueue.main.async { self.sceneView?.session.pause() }
  }

  public func resumeSession() {
    guard ARWorldTrackingConfiguration.isSupported else { return }
    let config = ARWorldTrackingConfiguration()
    config.planeDetection = [.horizontal, .vertical]
    DispatchQueue.main.async {
      self.sceneView?.session.run(config, options: [])
    }
  }

  // MARK: - Frame capture

  public func captureFrame(quality: Double) throws -> String {
    guard let frame = sceneView?.session.currentFrame else {
      throw NSError(domain: "ARSession", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "No AR frame available"])
    }
    let pixelBuffer = frame.capturedImage
    let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
    let context = CIContext(options: [.useSoftwareRenderer: false])
    guard let cgImage = context.createCGImage(ciImage, from: ciImage.extent) else {
      throw NSError(domain: "ARSession", code: 2,
                    userInfo: [NSLocalizedDescriptionKey: "Failed to create CGImage"])
    }
    // Rotate to match phone orientation
    let uiImage = UIImage(cgImage: cgImage, scale: 1.0, orientation: .right)
    // Downscale to 768px wide for Moondream (reduce upload size ~85%)
    let targetWidth: CGFloat = 768
    let scale = targetWidth / uiImage.size.width
    let targetSize = CGSize(width: targetWidth, height: uiImage.size.height * scale)
    UIGraphicsBeginImageContextWithOptions(targetSize, true, 1.0)
    uiImage.draw(in: CGRect(origin: .zero, size: targetSize))
    let resized = UIGraphicsGetImageFromCurrentImageContext()!
    UIGraphicsEndImageContext()

    guard let jpegData = resized.jpegData(compressionQuality: CGFloat(quality)) else {
      throw NSError(domain: "ARSession", code: 3,
                    userInfo: [NSLocalizedDescriptionKey: "JPEG encoding failed"])
    }
    return jpegData.base64EncodedString()
  }

  // MARK: - Hit test / Raycast

  public func hitTest(xNorm: Double, yNorm: Double) -> [Double]? {
    guard let sv = sceneView else { return nil }
    // Clamp to valid range
    let px = max(0, min(1, xNorm))
    let py = max(0, min(1, yNorm))
    let point = CGPoint(x: sv.bounds.width * CGFloat(px),
                        y: sv.bounds.height * CGFloat(py))

    if #available(iOS 14.0, *) {
      if let query = sv.raycastQuery(from: point,
                                      allowing: .estimatedPlane,
                                      alignment: .any),
         let result = sv.session.raycast(query).first {
        return matrixToArray(result.worldTransform)
      }
    }
    // Fallback for iOS 13
    let results = sv.hitTest(point, types: [.existingPlaneUsingExtent, .featurePoint])
    guard let hit = results.first else { return nil }
    return matrixToArray(hit.worldTransform)
  }

  // MARK: - Anchor management

  public func createAnchor(id: String, matrix: [Double]) {
    guard matrix.count == 16 else { return }
    let t = simd_float4x4(columns: (
      simd_float4(Float(matrix[0]),  Float(matrix[1]),  Float(matrix[2]),  Float(matrix[3])),
      simd_float4(Float(matrix[4]),  Float(matrix[5]),  Float(matrix[6]),  Float(matrix[7])),
      simd_float4(Float(matrix[8]),  Float(matrix[9]),  Float(matrix[10]), Float(matrix[11])),
      simd_float4(Float(matrix[12]), Float(matrix[13]), Float(matrix[14]), Float(matrix[15]))
    ))
    let anchor = ARAnchor(name: id, transform: t)
    DispatchQueue.main.async {
      self.sceneView?.session.add(anchor: anchor)
      self.anchors[id] = anchor
    }
  }

  public func removeAnchor(id: String) {
    DispatchQueue.main.async {
      if let anchor = self.anchors[id] {
        self.sceneView?.session.remove(anchor: anchor)
        self.anchors.removeValue(forKey: id)
      }
    }
  }

  public func removeAllAnchors() {
    DispatchQueue.main.async {
      for anchor in self.anchors.values {
        self.sceneView?.session.remove(anchor: anchor)
      }
      self.anchors = [:]
    }
  }

  // MARK: - Projection

  public func getProjectedPositions() -> [[String: Any]] {
    guard let sv = sceneView else { return [] }
    let viewSize = sv.bounds.size
    guard viewSize.width > 0 && viewSize.height > 0 else { return [] }

    var result: [[String: Any]] = []
    for (id, anchor) in anchors {
      let worldPos = SCNVector3(anchor.transform.columns.3.x,
                                anchor.transform.columns.3.y,
                                anchor.transform.columns.3.z)
      let proj = sv.projectPoint(worldPos)
      // proj.z: 0 = near clip, 1 = far clip; negative z means behind camera
      let inFrustum = proj.z > 0 && proj.z < 1
      let onScreen = proj.x >= 0 && proj.x <= Float(viewSize.width) &&
                     proj.y >= 0 && proj.y <= Float(viewSize.height)
      let isVisible = inFrustum && onScreen

      // Depth in metres from camera (approximate)
      let camPos = sv.pointOfView?.position ?? SCNVector3Zero
      let dx = worldPos.x - camPos.x
      let dy = worldPos.y - camPos.y
      let dz = worldPos.z - camPos.z
      let depth = max(0.1, Double(sqrt(dx*dx + dy*dy + dz*dz)))

      result.append([
        "id": id,
        "screenX": Double(proj.x),
        "screenY": Double(proj.y),
        "depth": depth,
        "isVisible": isVisible,
      ])
    }
    return result
  }

  public func getTrackingState() -> String {
    guard let frame = sceneView?.session.currentFrame else { return "not_available" }
    switch frame.camera.trackingState {
    case .normal:        return "normal"
    case .limited:       return "limited"
    case .notAvailable:  return "not_available"
    }
  }

  // MARK: - Helpers

  private func matrixToArray(_ m: simd_float4x4) -> [Double] {
    return [
      Double(m.columns.0.x), Double(m.columns.0.y), Double(m.columns.0.z), Double(m.columns.0.w),
      Double(m.columns.1.x), Double(m.columns.1.y), Double(m.columns.1.z), Double(m.columns.1.w),
      Double(m.columns.2.x), Double(m.columns.2.y), Double(m.columns.2.z), Double(m.columns.2.w),
      Double(m.columns.3.x), Double(m.columns.3.y), Double(m.columns.3.z), Double(m.columns.3.w),
    ]
  }
}
