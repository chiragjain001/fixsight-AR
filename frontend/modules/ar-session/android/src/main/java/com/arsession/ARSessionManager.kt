// ARSessionManager.kt
// Singleton managing the ARCore session, anchors, and projections.
// Shared between ARSessionModule and ARSessionView.

package com.arsession

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.util.Base64
import com.google.ar.core.*
import com.google.ar.core.exceptions.*
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.sqrt

object ARSessionManager {

    var session: Session? = null
    var currentFrame: Frame? = null

    // anchor id → Anchor
    val anchors: MutableMap<String, Anchor> = mutableMapOf()

    // Callback set by ARSessionView when a new frame is available
    var onFrameAvailable: ((Frame) -> Unit)? = null

    // Screen dimensions — set by ARSessionView on creation
    var viewWidth: Int = 0
    var viewHeight: Int = 0

    // Projection matrices updated every GL frame by ARSessionView
    var lastProjMatrix: FloatArray? = null
    var lastViewMatrix: FloatArray? = null

    fun startSession(context: Context) {
        try {
            if (ArCoreApk.getInstance().requestInstall(null, true) !=
                ArCoreApk.InstallStatus.INSTALLED) return

            val s = Session(context)
            val config = Config(s).apply {
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                lightEstimationMode = Config.LightEstimationMode.DISABLED
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
            }
            s.configure(config)
            s.resume()
            session = s
        } catch (e: Exception) {
            android.util.Log.e("ARSession", "startSession failed: ${e.message}")
        }
    }

    fun stopSession() {
        anchors.values.forEach { it.detach() }
        anchors.clear()
        session?.pause()
        session?.close()
        session = null
    }

    fun pauseSession() { session?.pause() }

    fun resumeSession() { try { session?.resume() } catch (e: Exception) { } }

    fun isSupported(context: Context): Boolean {
        return ArCoreApk.getInstance().checkAvailability(context) ==
            ArCoreApk.Availability.SUPPORTED_INSTALLED
    }

    // ── Frame capture ─────────────────────────────────────────────────────────

    fun captureFrame(quality: Float): String {
        val frame = currentFrame ?: throw IllegalStateException("No AR frame available")
        val image = frame.acquireCameraImage()
        try {
            val bitmap = imageToBitmap(image)
            // Downscale to 768px wide
            val scale = 768f / bitmap.width
            val scaled = Bitmap.createScaledBitmap(
                bitmap,
                768,
                (bitmap.height * scale).toInt(),
                true
            )
            val out = ByteArrayOutputStream()
            scaled.compress(Bitmap.CompressFormat.JPEG, (quality * 100).toInt(), out)
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
            image.close()
        }
    }

    private fun imageToBitmap(image: android.media.Image): Bitmap {
        // YUV_420_888 → JPEG via NV21 conversion
        val yBuffer = image.planes[0].buffer
        val uBuffer = image.planes[1].buffer
        val vBuffer = image.planes[2].buffer
        val ySize = yBuffer.remaining()
        val uSize = uBuffer.remaining()
        val vSize = vBuffer.remaining()
        val nv21 = ByteArray(ySize + uSize + vSize)
        yBuffer.get(nv21, 0, ySize)
        vBuffer.get(nv21, ySize, vSize)
        uBuffer.get(nv21, ySize + vSize, uSize)
        val yuvImage = android.graphics.YuvImage(
            nv21, ImageFormat.NV21, image.width, image.height, null
        )
        val out = ByteArrayOutputStream()
        yuvImage.compressToJpeg(
            android.graphics.Rect(0, 0, image.width, image.height), 90, out
        )
        val bytes = out.toByteArray()
        // Rotate 90° to correct camera orientation
        val raw = BitmapFactory.decodeByteArray(bytes, 0, bytes.size)
        val matrix = Matrix().apply { postRotate(90f) }
        return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
    }

    // ── Hit test ──────────────────────────────────────────────────────────────

    fun hitTest(xNorm: Float, yNorm: Float): FloatArray? {
        val frame = currentFrame ?: return null
        val x = xNorm * viewWidth
        val y = yNorm * viewHeight
        val results = frame.hitTest(x, y)
        // Prefer plane hits, fall back to point cloud
        val hit = results.firstOrNull { it.trackable is Plane } ?:
                  results.firstOrNull { it.trackable is Point } ?: return null
        val m = FloatArray(16)
        hit.hitPose.toMatrix(m, 0)
        return m
    }

    // ── Anchor management ─────────────────────────────────────────────────────

    fun createAnchor(id: String, matrix: FloatArray) {
        val frame = currentFrame ?: return
        val pose = Pose(
            floatArrayOf(matrix[12], matrix[13], matrix[14]),
            floatArrayToQuaternion(matrix)
        )
        val anchor = session?.createAnchor(pose) ?: return
        anchors[id]?.detach()
        anchors[id] = anchor
    }

    fun removeAnchor(id: String) {
        anchors.remove(id)?.detach()
    }

    fun removeAllAnchors() {
        anchors.values.forEach { it.detach() }
        anchors.clear()
    }

    // ── Projection ────────────────────────────────────────────────────────────

    fun getProjectedPositions(projMatrix: FloatArray, viewMatrix: FloatArray): List<Map<String, Any>> {
        val results = mutableListOf<Map<String, Any>>()
        for ((id, anchor) in anchors) {
            if (anchor.trackingState != TrackingState.TRACKING) {
                results.add(mapOf("id" to id, "screenX" to 0.0, "screenY" to 0.0,
                    "depth" to 1.0, "isVisible" to false))
                continue
            }
            val worldPos = FloatArray(4)
            anchor.pose.toMatrix(FloatArray(16), 0)
            worldPos[0] = anchor.pose.tx()
            worldPos[1] = anchor.pose.ty()
            worldPos[2] = anchor.pose.tz()
            worldPos[3] = 1f

            // World → View → Clip
            val viewPos = multiplyMatVec(viewMatrix, worldPos)
            val clipPos = multiplyMatVec(projMatrix, viewPos)
            if (clipPos[3] == 0f) continue

            val ndcX = clipPos[0] / clipPos[3]
            val ndcY = clipPos[1] / clipPos[3]
            val ndcZ = clipPos[2] / clipPos[3]

            val screenX = (ndcX * 0.5f + 0.5f) * viewWidth
            val screenY = ((1f - ndcY) * 0.5f) * viewHeight  // flip Y
            val isVisible = ndcZ in 0f..1f && ndcX in -1f..1f && ndcY in -1f..1f

            val depth = maxOf(0.1f, kotlin.math.abs(viewPos[2])).toDouble()

            results.add(mapOf(
                "id" to id,
                "screenX" to screenX.toDouble(),
                "screenY" to screenY.toDouble(),
                "depth" to depth,
                "isVisible" to isVisible
            ))
        }
        return results
    }

    fun getTrackingState(): String {
        val frame = currentFrame ?: return "not_available"
        return when (frame.camera.trackingState) {
            TrackingState.TRACKING -> "normal"
            TrackingState.PAUSED -> "limited"
            TrackingState.STOPPED -> "not_available"
        }
    }

    // ── Math helpers ──────────────────────────────────────────────────────────

    private fun multiplyMatVec(m: FloatArray, v: FloatArray): FloatArray {
        return floatArrayOf(
            m[0]*v[0] + m[4]*v[1] + m[8]*v[2]  + m[12]*v[3],
            m[1]*v[0] + m[5]*v[1] + m[9]*v[2]  + m[13]*v[3],
            m[2]*v[0] + m[6]*v[1] + m[10]*v[2] + m[14]*v[3],
            m[3]*v[0] + m[7]*v[1] + m[11]*v[2] + m[15]*v[3]
        )
    }

    private fun floatArrayToQuaternion(matrix: FloatArray): FloatArray {
        // Extract rotation quaternion from 4x4 column-major matrix
        val m00 = matrix[0]; val m01 = matrix[1]; val m02 = matrix[2]
        val m10 = matrix[4]; val m11 = matrix[5]; val m12 = matrix[6]
        val m20 = matrix[8]; val m21 = matrix[9]; val m22 = matrix[10]
        val trace = m00 + m11 + m22
        return if (trace > 0) {
            val s = 0.5f / sqrt((trace + 1.0f).toDouble()).toFloat()
            floatArrayOf(0.25f / s, (m21 - m12) * s, (m02 - m20) * s, (m10 - m01) * s)
        } else floatArrayOf(1f, 0f, 0f, 0f)
    }
}
