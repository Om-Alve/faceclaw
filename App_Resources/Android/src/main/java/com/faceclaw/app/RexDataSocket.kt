package com.faceclaw.app

import android.os.Handler
import android.os.Looper
import android.util.Log

import java.nio.ByteBuffer
import java.util.concurrent.TimeUnit

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * Callbacks for RexDataSocket, delivered on the Looper of the thread that
 * constructed it. None arrive once close() has been called.
 */
interface RexDataSocketListener {
    fun onOpen(): Unit

    /** One binary message, never empty. A direct buffer of exactly its bytes, for JS to view and copy. */
    fun onBinaryMessage(frame: ByteBuffer): Unit

    /** The server closed the connection with this status and reason. */
    fun onClosed(code: Int, reason: String): Unit

    /** The handshake failed, or the connection dropped without a close frame. */
    fun onFailure(message: String): Unit
}

/**
 * One Rex data connection, `GET /api/data`. Rex sends the stream as binary
 * messages only, so text messages are not surfaced. The subprotocol comes from
 * the TypeScript caller (REX_DATA_SUBPROTOCOL in app/apps/terminal/rex/protocol.ts),
 * which also binds the data.connect ticket to it, so the string has one declaration.
 */
class RexDataSocket(url: String, subprotocol: String, listener: RexDataSocketListener) {
    private val callbackHandler = Handler(Looper.myLooper() ?: Looper.getMainLooper())
    private val socket: WebSocket
    @Volatile
    private var closeRequested = false

    init {
        val request = Request.Builder().url(url).header(SUBPROTOCOL_HEADER, subprotocol).build()
        socket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                deliver("onOpen") { listener.onOpen() }
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                // A zero-capacity direct buffer may have no address for JS to view, and an
                // empty message carries no stream bytes.
                if (bytes.size == 0) return
                val frame = ByteBuffer.allocateDirect(bytes.size)
                frame.put(bytes.asByteBuffer())
                deliver("onBinaryMessage") { listener.onBinaryMessage(frame) }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(code, reason)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                deliver("onClosed") { listener.onClosed(code, reason) }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                val message = t.toString()
                deliver("onFailure") { listener.onFailure(message) }
            }
        })
    }

    private fun deliver(name: String, callback: () -> Unit) {
        callbackHandler.post {
            if (closeRequested) return@post
            try {
                callback()
            } catch (t: Throwable) {
                Log.w(TAG, "listener $name failed", t)
            }
        }
    }

    /** Sends `bytes` from position to limit as one binary message. False once closing or failed. */
    fun sendBinary(bytes: ByteBuffer): Boolean {
        return socket.send(bytes.toByteString())
    }

    /** Call on the constructing thread, so that no callback runs after this returns. */
    fun close(code: Int, reason: String) {
        closeRequested = true
        if (!socket.close(code, reason)) {
            socket.cancel()
        }
    }

    companion object {
        private const val TAG = "RexDataSocket"
        private const val SUBPROTOCOL_HEADER = "Sec-WebSocket-Protocol"
        private const val EXTENSIONS_HEADER = "Sec-WebSocket-Extensions"
        // Rex keeps a dropped stream for 60 s. OkHttp fails the socket one interval after an
        // unanswered ping, so a dead link surfaces within two intervals, in time to RESUME.
        private const val PING_INTERVAL_SECONDS = 20L

        private val client: OkHttpClient by lazy {
            OkHttpClient.Builder()
                .pingInterval(PING_INTERVAL_SECONDS, TimeUnit.SECONDS)
                .addInterceptor(FaceclawHttp.userAgentInterceptor())
                // OkHttp always offers permessage-deflate and rejects a caller's own value. Rex's
                // API says data connections are never compressed, yet it accepts the offer and
                // deflates large frames, so withdraw the offer here.
                .addInterceptor { chain ->
                    chain.proceed(chain.request().newBuilder().removeHeader(EXTENSIONS_HEADER).build())
                }
                .build()
        }
    }
}
