// ARSessionModule.kt
// Production Expo Module — exposes ARSessionManager to React Native JS.

package com.arsession

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.Promise

class ARSessionModule : Module() {

    override fun definition() = ModuleDefinition {

        Name("ARSessionModule")

        Events("onAnchorPositionsUpdated", "onTrackingStateChanged")

        // ── Lifecycle ───────────────────────────────────────────────────────────

        AsyncFunction("isSupported") { promise: Promise ->
            val ctx = appContext.reactContext
            if (ctx == null) {
                promise.resolve(false)
                return@AsyncFunction
            }
            promise.resolve(ARSessionManager.isSupported(ctx))
        }

        AsyncFunction("startSession") { promise: Promise ->
            val ctx = appContext.reactContext
            if (ctx == null) {
                promise.reject("NO_CONTEXT", "React context is unavailable", null)
                return@AsyncFunction
            }
            try {
                ARSessionManager.startSession(ctx)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("START_FAILED", e.message ?: "Unknown error", e)
            }
        }

        AsyncFunction("stopSession") { promise: Promise ->
            try {
                ARSessionManager.stopSession()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("STOP_FAILED", e.message ?: "Unknown error", e)
            }
        }

        AsyncFunction("pauseSession") { promise: Promise ->
            ARSessionManager.pauseSession()
            promise.resolve(null)
        }

        AsyncFunction("resumeSession") { promise: Promise ->
            ARSessionManager.resumeSession()
            promise.resolve(null)
        }

        // ── Frame capture ───────────────────────────────────────────────────────

        AsyncFunction("captureFrame") { quality: Double, promise: Promise ->
            try {
                val base64 = ARSessionManager.captureFrame(quality.toFloat())
                promise.resolve(mapOf("base64" to base64))
            } catch (e: IllegalStateException) {
                promise.reject("NO_FRAME", e.message ?: "No AR frame available", e)
            } catch (e: Exception) {
                promise.reject("CAPTURE_FAILED", e.message ?: "Frame capture failed", e)
            }
        }

        // ── Spatial operations ──────────────────────────────────────────────────

        AsyncFunction("hitTest") { xNorm: Double, yNorm: Double, promise: Promise ->
            try {
                val matrix = ARSessionManager.hitTest(xNorm.toFloat(), yNorm.toFloat())
                if (matrix == null) {
                    promise.resolve(null)
                } else {
                    promise.resolve(matrix.map { it.toDouble() })
                }
            } catch (e: Exception) {
                promise.reject("HIT_TEST_FAILED", e.message ?: "Hit test failed", e)
            }
        }

        AsyncFunction("createAnchor") { id: String, matrix: List<Double>, promise: Promise ->
            try {
                if (matrix.size != 16) {
                    promise.reject("INVALID_MATRIX", "Matrix must have exactly 16 elements", null)
                    return@AsyncFunction
                }
                val floatMatrix = FloatArray(16) { matrix[it].toFloat() }
                ARSessionManager.createAnchor(id, floatMatrix)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("CREATE_ANCHOR_FAILED", e.message ?: "Create anchor failed", e)
            }
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
            val proj = ARSessionManager.lastProjMatrix
            val view = ARSessionManager.lastViewMatrix
            if (proj == null || view == null) {
                promise.resolve(emptyList<Any>())
                return@AsyncFunction
            }
            try {
                val positions = ARSessionManager.getProjectedPositions(proj, view)
                promise.resolve(positions)
            } catch (e: Exception) {
                promise.reject("PROJECTION_FAILED", e.message ?: "Projection failed", e)
            }
        }

        AsyncFunction("getTrackingState") { promise: Promise ->
            promise.resolve(ARSessionManager.getTrackingState())
        }

        // ── Native View ─────────────────────────────────────────────────────────

        View(ARSessionView::class) {}
    }
}
