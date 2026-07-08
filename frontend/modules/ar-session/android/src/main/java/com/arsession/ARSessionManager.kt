// ARSessionManager.kt
// Production-grade singleton managing the ARCore session, anchors, and projections.

package com.arsession

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.ImageFormat
import android.graphics.Matrix
import android.util.Base64
import android.util.Log
import com.google.ar.core.*
import com.google.ar.core.exceptions.*
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import kotlin.math.abs
import kotlin.math.sqrt

private const val TAG = "ARSessionManager"

object ARSessionManager {

    var session: Session? = null
        private set

    var currentFrame: Frame? = null

    val anchors: MutableMap<String, Anchor> = mutableMapOf()

    var onFrameAvailable: ((Frame) -> Unit)? = null

    var viewWidth: Int = 0
    var viewHeight: Int = 0

    var lastProjMatrix: FloatArray? = null
    var lastViewMatrix: FloatArray? = null

    // ── Support check ──────────────────────────────────────────────────────────
    // Returns true if the device hardware is capable of running ARCore,
    // regardless of whether ARCore is currently installed/updated.
    // The startSession() call will trigger the install/update flow if needed.
    fun isSupported(context: Context): Boolean {
        return try {
            when (ArCoreApk.getInstance().checkAvailability(context)) {
                // Fully ready
                ArCoreApk.Availability.SUPPORTED_INSTALLED -> true

                // Device is capable; ARCore just needs to be installed or updated.
                // startSession() will trigger the Play Store install prompt.
                ArCoreApk.Availability.SUPPORTED_NOT_INSTALLED,
                ArCoreApk.Availability.SUPPORTED_APK_TOO_OLD -> true

                // Availability check is still in progress (network request).
                // Treat as supported and let startSession() confirm.
                ArCoreApk.Availability.UNKNOWN_CHECKING -> true

                // Device is definitely not capable.
                ArCoreApk.Availability.UNSUPPORTED_DEVICE_NOT_CAPABLE -> {
                    Log.w(TAG, "ARCore is not supported on this device hardware.")
                    false
                }

                // Unknown error or timeout — optimistically allow, let session fail gracefully.
                ArCoreApk.Availability.UNKNOWN_ERROR,
                ArCoreApk.Availability.UNKNOWN_TIMED_OUT -> {
                    Log.w(TAG, "ARCore availability check returned unknown state — assuming capable.")
                    true
                }

                else -> false
            }
        } catch (e: Exception) {
            Log.e(TAG, "isSupported() threw an exception: ${e.message}", e)
            false
        }
    }

    // ── Session lifecycle ──────────────────────────────────────────────────────

    fun startSession(context: Context) {
        if (session != null) {
            Log.d(TAG, "Session already active, skipping startSession().")
            return
        }
        try {
            // requestInstall requires an Activity to show the install UI.
            // If context is not an Activity (e.g. Application context), we skip
            // the install check and attempt to create the session directly.
            val activity = context as? android.app.Activity
            if (activity != null) {
                val installStatus = ArCoreApk.getInstance().requestInstall(activity, true)
                if (installStatus != ArCoreApk.InstallStatus.INSTALLED) {
                    // INSTALL_REQUESTED: Play Store dialog was shown to the user.
                    // The session will be created on the next app resume.
                    Log.i(TAG, "ARCore install requested, waiting for user action.")
                    return
                }
            } else {
                Log.w(TAG, "Context is not an Activity — skipping ARCore install check.")
            }

            val s = Session(context)
            val config = Config(s).apply {
                planeFindingMode = Config.PlaneFindingMode.HORIZONTAL_AND_VERTICAL
                lightEstimationMode = Config.LightEstimationMode.AMBIENT_INTENSITY
                updateMode = Config.UpdateMode.LATEST_CAMERA_IMAGE
                depthMode = if (s.isDepthModeSupported(Config.DepthMode.AUTOMATIC)) {
                    Config.DepthMode.AUTOMATIC
                } else {
                    Config.DepthMode.DISABLED
                }
            }
            s.configure(config)
            s.resume()
            session = s
            Log.i(TAG, "ARCore session started successfully.")
        } catch (e: UnavailableArcoreNotInstalledException) {
            Log.e(TAG, "ARCore is not installed: ${e.message}")
        } catch (e: UnavailableApkTooOldException) {
            Log.e(TAG, "ARCore APK is too old: ${e.message}")
        } catch (e: UnavailableSdkTooOldException) {
            Log.e(TAG, "ARCore SDK is too old: ${e.message}")
        } catch (e: UnavailableDeviceNotCompatibleException) {
            Log.e(TAG, "Device is not compatible with ARCore: ${e.message}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start ARCore session: ${e.message}", e)
        }
    }

    fun stopSession() {
        try {
            anchors.values.forEach { it.detach() }
            anchors.clear()
            currentFrame = null
            lastProjMatrix = null
            lastViewMatrix = null
            session?.pause()
            session?.close()
            session = null
            Log.i(TAG, "ARCore session stopped.")
        } catch (e: Exception) {
            Log.e(TAG, "Error stopping ARCore session: ${e.message}", e)
        }
    }

    fun pauseSession() {
        try { session?.pause() } catch (e: Exception) {
            Log.w(TAG, "pauseSession error: ${e.message}")
        }
    }

    fun resumeSession() {
        try { session?.resume() } catch (e: Exception) {
            Log.w(TAG, "resumeSession error: ${e.message}")
        }
    }

    // ── Frame capture ──────────────────────────────────────────────────────────

    fun captureFrame(quality: Float): String {
        val frame = currentFrame ?: throw IllegalStateException("No AR frame available yet.")
        val image = frame.acquireCameraImage()
        return try {
            val bitmap = yuv420ToBitmap(image)
            val targetWidth = 768
            val scale = targetWidth.toFloat() / bitmap.width
            val scaledBitmap = Bitmap.createScaledBitmap(
                bitmap,
                targetWidth,
                (bitmap.height * scale).toInt(),
                true
            )
            val out = ByteArrayOutputStream()
            scaledBitmap.compress(
                Bitmap.CompressFormat.JPEG,
                (quality.coerceIn(0f, 1f) * 100).toInt(),
                out
            )
            Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
        } finally {
            image.close()
        }
    }

    private fun yuv420ToBitmap(image: android.media.Image): Bitmap {
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
        val raw = BitmapFactory.decodeByteArray(out.toByteArray(), 0, out.size())
        val matrix = Matrix().apply { postRotate(90f) }
        return Bitmap.createBitmap(raw, 0, 0, raw.width, raw.height, matrix, true)
    }

    // ── Hit test ──────────────────────────────────────────────────────────────

    fun hitTest(xNorm: Float, yNorm: Float): FloatArray? {
        val frame = currentFrame ?: return null
        if (viewWidth == 0 || viewHeight == 0) return null
        val x = xNorm * viewWidth
        val y = yNorm * viewHeight
        val results = frame.hitTest(x, y)
        val hit = results.firstOrNull { it.trackable is Plane }
            ?: results.firstOrNull { it.trackable is Point }
            ?: return null
        val matrix = FloatArray(16)
        hit.hitPose.toMatrix(matrix, 0)
        return matrix
    }

    // ── Anchor management ─────────────────────────────────────────────────────

    fun createAnchor(id: String, matrix: FloatArray) {
        val s = session ?: run {
            Log.w(TAG, "createAnchor: session is null")
            return
        }
        val frame = currentFrame ?: run {
            Log.w(TAG, "createAnchor: no current frame")
            return
        }
        val pose = Pose(
            floatArrayOf(matrix[12], matrix[13], matrix[14]),
            rotationMatrixToQuaternion(matrix)
        )
        val anchor = s.createAnchor(pose)
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

    fun getProjectedPositions(
        projMatrix: FloatArray,
        viewMatrix: FloatArray
    ): List<Map<String, Any>> {
        return anchors.mapNotNull { (id, anchor) ->
            if (anchor.trackingState != TrackingState.TRACKING) {
                return@mapNotNull mapOf(
                    "id" to id,
                    "screenX" to 0.0,
                    "screenY" to 0.0,
                    "depth" to 1.0,
                    "isVisible" to false
                )
            }
            val worldPos = floatArrayOf(
                anchor.pose.tx(), anchor.pose.ty(), anchor.pose.tz(), 1f
            )
            val viewPos = multiplyMatVec(viewMatrix, worldPos)
            val clipPos = multiplyMatVec(projMatrix, viewPos)
            val w = clipPos[3]
            if (w == 0f) return@mapNotNull null

            val ndcX = clipPos[0] / w
            val ndcY = clipPos[1] / w
            val ndcZ = clipPos[2] / w
            val screenX = (ndcX * 0.5f + 0.5f) * viewWidth
            val screenY = ((1f - ndcY) * 0.5f) * viewHeight
            val isVisible = ndcZ in 0f..1f && ndcX in -1f..1f && ndcY in -1f..1f
            val depth = abs(viewPos[2]).coerceAtLeast(0.1f).toDouble()

            mapOf(
                "id" to id,
                "screenX" to screenX.toDouble(),
                "screenY" to screenY.toDouble(),
                "depth" to depth,
                "isVisible" to isVisible
            )
        }
    }

    fun getTrackingState(): String {
        val frame = currentFrame ?: return "not_available"
        return when (frame.camera.trackingState) {
            TrackingState.TRACKING -> "normal"
            TrackingState.PAUSED   -> "limited"
            TrackingState.STOPPED  -> "not_available"
        }
    }

    // ── Math helpers ──────────────────────────────────────────────────────────

    private fun multiplyMatVec(m: FloatArray, v: FloatArray): FloatArray = floatArrayOf(
        m[0] * v[0] + m[4] * v[1] + m[8]  * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9]  * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]
    )

    private fun rotationMatrixToQuaternion(m: FloatArray): FloatArray {
        val trace = m[0] + m[5] + m[10]
        return if (trace > 0f) {
            val s = 0.5f / sqrt((trace + 1f).toDouble()).toFloat()
            floatArrayOf(0.25f / s, (m[9] - m[6]) * s, (m[2] - m[8]) * s, (m[4] - m[1]) * s)
        } else if (m[0] > m[5] && m[0] > m[10]) {
            val s = 2f * sqrt((1f + m[0] - m[5] - m[10]).toDouble()).toFloat()
            floatArrayOf((m[9] - m[6]) / s, 0.25f * s, (m[1] + m[4]) / s, (m[2] + m[8]) / s)
        } else if (m[5] > m[10]) {
            val s = 2f * sqrt((1f + m[5] - m[0] - m[10]).toDouble()).toFloat()
            floatArrayOf((m[2] - m[8]) / s, (m[1] + m[4]) / s, 0.25f * s, (m[6] + m[9]) / s)
        } else {
            val s = 2f * sqrt((1f + m[10] - m[0] - m[5]).toDouble()).toFloat()
            floatArrayOf((m[4] - m[1]) / s, (m[2] + m[8]) / s, (m[6] + m[9]) / s, 0.25f * s)
        }
    }
}
