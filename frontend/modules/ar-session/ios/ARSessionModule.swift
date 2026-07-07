// ARSessionModule.swift
// Expo Module — exposes ARSessionManager's capabilities to React Native JS.
// React Native calls these async functions. The module never touches UI directly;
// all AR operations are delegated to ARSessionManager.shared.

import ExpoModulesCore
import ARKit

public class ARSessionModule: Module {

  public func definition() -> ModuleDefinition {

    Name("ARSessionModule")

    // ── Events emitted to JS ──────────────────────────────────────────────────
    Events("onAnchorPositionsUpdated", "onTrackingStateChanged")

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    AsyncFunction("isSupported") { () -> Bool in
      return ARWorldTrackingConfiguration.isSupported
    }

    AsyncFunction("startSession") { () -> Void in
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

    // ── Frame capture ─────────────────────────────────────────────────────────

    AsyncFunction("captureFrame") { (quality: Double) -> [String: Any] in
      let base64 = try ARSessionManager.shared.captureFrame(quality: quality)
      return ["base64": base64]
    }

    // ── Spatial ───────────────────────────────────────────────────────────────

    AsyncFunction("hitTest") { (xNorm: Double, yNorm: Double) -> [Double]? in
      return ARSessionManager.shared.hitTest(xNorm: xNorm, yNorm: yNorm)
    }

    AsyncFunction("createAnchor") { (id: String, matrix: [Double]) -> Void in
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

    // ── Native View ───────────────────────────────────────────────────────────
    View(ARSessionView.self)
  }
}
