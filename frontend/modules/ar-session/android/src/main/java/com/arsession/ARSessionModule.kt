// ARSessionModule.kt
// Expo Module — exposes ARSessionManager to React Native JS.

package com.arsession

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class ARSessionModule : Module() {

  override fun definition() = ModuleDefinition {

    Name("ARSessionModule")

    Events("onAnchorPositionsUpdated", "onTrackingStateChanged")

    // ── Lifecycle ─────────────────────────────────────────────────────────────

    AsyncFunction("isSupported") { promise: Promise ->
      val ctx = appContext.reactContext ?: return@AsyncFunction promise.resolve(false)
      promise.resolve(ARSessionManager.isSupported(ctx))
    }

    AsyncFunction("startSession") { promise: Promise ->
      val ctx = appContext.reactContext ?: return@AsyncFunction promise.reject(
        "NO_CONTEXT", "React context unavailable", null)
      ARSessionManager.startSession(ctx)
      promise.resolve(null)
    }

    AsyncFunction("stopSession") { promise: Promise ->
      ARSessionManager.stopSession()
      promise.resolve(null)
    }

    AsyncFunction("pauseSession") { promise: Promise ->
      ARSessionManager.pauseSession()
      promise.resolve(null)
    }

    AsyncFunction("resumeSession") { promise: Promise ->
      ARSessionManager.resumeSession()
      promise.resolve(null)
    }

    // ── Frame capture ─────────────────────────────────────────────────────────

    AsyncFunction("captureFrame") { quality: Double, promise: Promise ->
      try {
        val base64 = ARSessionManager.captureFrame(quality.toFloat())
        promise.resolve(mapOf("base64" to base64))
      } catch (e: Exception) {
        promise.reject("CAPTURE_FAILED", e.message, e)
      }
    }

    // ── Spatial ───────────────────────────────────────────────────────────────

    AsyncFunction("hitTest") { xNorm: Double, yNorm: Double, promise: Promise ->
      val matrix = ARSessionManager.hitTest(xNorm.toFloat(), yNorm.toFloat())
      if (matrix == null) {
        promise.resolve(null)
      } else {
        // Convert FloatArray to List<Double> for JS
        promise.resolve(matrix.map { it.toDouble() })
      }
    }

    AsyncFunction("createAnchor") { id: String, matrix: List<Double>, promise: Promise ->
      val floatMatrix = FloatArray(16) { matrix[it].toFloat() }
      ARSessionManager.createAnchor(id, floatMatrix)
      promise.resolve(null)
    }

    AsyncFunction("removeAnchor") { id: String, promise: Promise ->
      ARSessionManager.removeAnchor(id)
      promise.resolve(null)
    }

    AsyncFunction("removeAllAnchors") { promise: Promise ->
      ARSessionManager.removeAllAnchors()
      promise.resolve(null)
    }

    AsyncFunction("getProjectedPositions") { promise: Promise ->
      // The view sets these matrices each frame via ARSessionManager
      val proj = ARSessionManager.lastProjMatrix
      val view = ARSessionManager.lastViewMatrix
      if (proj == null || view == null) {
        promise.resolve(emptyList<Any>())
        return@AsyncFunction
      }
      val positions = ARSessionManager.getProjectedPositions(proj, view)
      promise.resolve(positions)
    }

    AsyncFunction("getTrackingState") { promise: Promise ->
      promise.resolve(ARSessionManager.getTrackingState())
    }

    // ── Native View ───────────────────────────────────────────────────────────
    View(ARSessionView::class)
  }
}
