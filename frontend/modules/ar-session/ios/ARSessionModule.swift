// ARSessionModule.swift
// Production Expo Module — exposes ARSessionManager to React Native JS.
// All AR operations are delegated to ARSessionManager.shared.

import ExpoModulesCore
import ARKit

public class ARSessionModule: Module {

  public func definition() -> ModuleDefinition {

    Name("ARSessionModule")

    // ── Events emitted to JS ────────────────────────────────────────────────────
    Events("onAnchorPositionsUpdated", "onTrackingStateChanged")

    // ── Lifecycle ───────────────────────────────────────────────────────────────

    // isSupported: ARWorldTrackingConfiguration.isSupported is the correct
    // Apple API for checking ARKit hardware support (A9 chip or later).
    AsyncFunction("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.isSupported
    }

    AsyncFunction("startSession") { () -> Void in
      guard ARWorldTrackingConfiguration.isSupported else {
        throw Exception(name: "UNSUPPORTED", description: "ARKit is not supported on this device.")
      }
      ARSessionManager.shared.startSession()
    }

    AsyncFunction("stopSession") { () -> Void in
      ARSessionManager.shared.stopSession()
    }

    AsyncFunction("pauseSession") { () -> Void in
      ARSessionManager.shared.pauseSession()
    }

    AsyncFunction("resumeSession") { () -> Void in
      ARSessionManager.shared.resumeSession()
    }

    // ── Frame capture ───────────────────────────────────────────────────────────

    AsyncFunction("captureFrame") { (quality: Double) -> [String: Any] in
      let base64 = try ARSessionManager.shared.captureFrame(quality: quality)
      return ["base64": base64]
    }

    // ── Spatial operations ──────────────────────────────────────────────────────

    AsyncFunction("hitTest") { (xNorm: Double, yNorm: Double) -> [Double]? in
      return ARSessionManager.shared.hitTest(xNorm: xNorm, yNorm: yNorm)
    }

    AsyncFunction("createAnchor") { (id: String, matrix: [Double]) -> Void in
      guard matrix.count == 16 else {
        throw Exception(name: "INVALID_MATRIX", description: "Matrix must have exactly 16 elements.")
      }
      ARSessionManager.shared.createAnchor(id: id, matrix: matrix)
    }

    AsyncFunction("removeAnchor") { (id: String) -> Void in
      ARSessionManager.shared.removeAnchor(id: id)
    }

    AsyncFunction("removeAllAnchors") { () -> Void in
      ARSessionManager.shared.removeAllAnchors()
    }

    AsyncFunction("getProjectedPositions") { () -> [[String: Any]] in
      return ARSessionManager.shared.getProjectedPositions()
    }

    AsyncFunction("getTrackingState") { () -> String in
      return ARSessionManager.shared.getTrackingState()
    }

    // ── Native View ─────────────────────────────────────────────────────────────
    // Empty trailing closure required for Expo SDK 52 type inference.
    View(ARSessionView.self) {}
  }
}
