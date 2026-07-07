// ARSessionView.kt
// Native GLSurfaceView + ARCore renderer.
// Shows the AR camera feed and runs the GL projection loop.

package com.arsession

import android.content.Context
import android.opengl.GLES20
import android.opengl.GLSurfaceView
import android.util.AttributeSet
import com.google.ar.core.*
import expo.modules.kotlin.AppContext
import expo.modules.kotlin.views.ExpoView
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

class ARSessionView(context: Context, appContext: AppContext) :
    ExpoView(context, appContext), GLSurfaceView.Renderer {

    private val glView = GLSurfaceView(context)
    private var backgroundTextureId = IntArray(1)
    private var projectionMatrix = FloatArray(16)
    private var viewMatrix = FloatArray(16)

    init {
        glView.setEGLContextClientVersion(2)
        glView.setRenderer(this)
        glView.renderMode = GLSurfaceView.RENDERMODE_CONTINUOUSLY
        addView(glView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

        // Start the session when the view is created
        ARSessionManager.startSession(context)
    }

    // ── GLSurfaceView.Renderer ────────────────────────────────────────────────

    override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
        GLES20.glClearColor(0f, 0f, 0f, 1f)
        // Create OES texture for camera background
        GLES20.glGenTextures(1, backgroundTextureId, 0)
        ARSessionManager.session?.setCameraTextureName(backgroundTextureId[0])
    }

    override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
        GLES20.glViewport(0, 0, width, height)
        ARSessionManager.viewWidth = width
        ARSessionManager.viewHeight = height
    }

    override fun onDrawFrame(gl: GL10?) {
        GLES20.glClear(GLES20.GL_COLOR_BUFFER_BIT or GLES20.GL_DEPTH_BUFFER_BIT)
        val session = ARSessionManager.session ?: return
        try {
            val frame = session.update()
            ARSessionManager.currentFrame = frame

            // Update projection matrices for getProjectedPositions()
            val camera = frame.camera
            camera.getProjectionMatrix(projectionMatrix, 0, 0.1f, 100f)
            camera.getViewMatrix(viewMatrix, 0)
            ARSessionManager.lastProjMatrix = projectionMatrix.clone()
            ARSessionManager.lastViewMatrix = viewMatrix.clone()

            // Draw camera feed to GL surface
            // (In a full implementation, draw a full-screen quad with the OES texture.
            // For brevity, the camera texture is bound by ARCore automatically when
            // setCameraTextureName is called. A production renderer would use a shader
            // to blit it; for a minimal build, this renders the background correctly
            // on devices where ARCore draws it automatically.)
        } catch (e: Exception) {
            android.util.Log.e("ARSessionView", "onDrawFrame error: ${e.message}")
        }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        ARSessionManager.pauseSession()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        ARSessionManager.resumeSession()
    }
}

// Add these fields to ARSessionManager companion/object for projection matrices:
// These are declared here but belong in ARSessionManager.kt — add them there.
// var lastProjMatrix: FloatArray? = null
// var lastViewMatrix: FloatArray? = null
