// ARSessionView.swift
// The native AR camera view component.
// Renders the live AR camera feed and registers itself with ARSessionManager
// so the module can perform hit tests and projections.

import ExpoModulesCore
import ARKit
import SceneKit

public class ARSessionView: ExpoView, ARSessionDelegate {

  // ── The ARSCNView — shows the camera feed ──────────────────────────────────
  private let sceneView = ARSCNView()

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  required init(appContext: AppContext? = nil) {
    super.init(appContext: appContext)
    setupSceneView()
  }

  private func setupSceneView() {
    sceneView.translatesAutoresizingMaskIntoConstraints = false
    addSubview(sceneView)
    NSLayoutConstraint.activate([
      sceneView.topAnchor.constraint(equalTo: topAnchor),
      sceneView.bottomAnchor.constraint(equalTo: bottomAnchor),
      sceneView.leadingAnchor.constraint(equalTo: leadingAnchor),
      sceneView.trailingAnchor.constraint(equalTo: trailingAnchor),
    ])

    // Minimal scene — we render labels in Skia/RN not in SceneKit
    sceneView.scene = SCNScene()
    sceneView.autoenablesDefaultLighting = false
    sceneView.automaticallyUpdatesLighting = false
    sceneView.rendersCameraGrain = false
    sceneView.rendersMotionBlur = false

    // Register with shared manager so ARSessionModule can use it
    ARSessionManager.shared.sceneView = sceneView
    sceneView.session.delegate = self

    // Start the AR session
    ARSessionManager.shared.startSession()
  }

  public override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      ARSessionManager.shared.resumeSession()
    } else {
      ARSessionManager.shared.pauseSession()
    }
  }

  // ── ARSessionDelegate ─────────────────────────────────────────────────────

  public func session(_ session: ARSession, didUpdate frame: ARFrame) {
    // Called every frame (~60fps). We use this to emit tracking state changes.
    let state = ARSessionManager.shared.getTrackingState()
    // Note: The JS layer polls getProjectedPositions() in its own rAF loop.
    // We don't emit positions here to avoid flooding the bridge.
    // Only emit significant tracking state changes.
    _ = state // suppress warning — state monitoring handled by useARSession hook
  }

  public func session(_ session: ARSession, cameraDidChangeTrackingState camera: ARCamera) {
    let state: String
    switch camera.trackingState {
    case .normal:       state = "normal"
    case .limited:      state = "limited"
    case .notAvailable: state = "not_available"
    }
    // Emit to JS — useARSession hook listens for this
    appContext?.eventEmitter?.sendEvent(
      withName: "onTrackingStateChanged",
      body: ["state": state]
    )
  }

  public func session(_ session: ARSession, didFailWithError error: Error) {
    print("[ARSessionView] Session failed: \(error.localizedDescription)")
    appContext?.eventEmitter?.sendEvent(
      withName: "onTrackingStateChanged",
      body: ["state": "not_available"]
    )
  }

  public func sessionWasInterrupted(_ session: ARSession) {
    appContext?.eventEmitter?.sendEvent(
      withName: "onTrackingStateChanged",
      body: ["state": "limited"]
    )
  }

  public func sessionInterruptionEnded(_ session: ARSession) {
    ARSessionManager.shared.resumeSession()
  }
}
