package com.claudebridge.data

import okhttp3.*
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.TimeUnit

class RelayClient(
    private val relayUrl: String,
    private val authToken: String
) {
    interface Listener {
        fun onConnected()
        fun onDisconnected()
        fun onChannelList(channels: List<Channel>, mode: String)
        fun onChannelUpdate(channelId: String, agentStatus: String?, pendingPermission: Boolean?)
        fun onModeChanged(mode: String)
        fun onMessage(message: ChatMessage)
        fun onHistory(channelId: String, messages: List<ChatMessage>, hasMore: Boolean)
        fun onError(error: String)
    }

    var listener: Listener? = null
    private var webSocket: WebSocket? = null
    private var connected = false
    private val client = OkHttpClient.Builder()
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    fun connect() {
        val wsUrl = relayUrl.replace("https://", "wss://").replace("http://", "ws://")
        val request = Request.Builder().url(wsUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Send auth
                val auth = JSONObject().apply {
                    put("type", "auth")
                    put("token", authToken)
                    put("clientType", "app")
                }
                webSocket.send(auth.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(JSONObject(text))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                connected = false
                listener?.onDisconnected()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                connected = false
                listener?.onError("Connection failed: ${t.message}")
                listener?.onDisconnected()
            }
        })
    }

    fun disconnect() {
        webSocket?.close(1000, "User disconnect")
        webSocket = null
        connected = false
    }

    fun sendMessage(channel: String, content: String) {
        val msg = JSONObject().apply {
            put("type", "send")
            put("channel", channel)
            put("content", content)
        }
        webSocket?.send(msg.toString())
    }

    fun sendPermissionResponse(channel: String, requestId: String, approved: Boolean, message: String? = null) {
        val msg = JSONObject().apply {
            put("type", "permission_response")
            put("channel", channel)
            put("requestId", requestId)
            put("approved", approved)
            if (message != null) put("message", message)
        }
        webSocket?.send(msg.toString())
    }

    fun sendSetMode(mode: String) {
        val msg = JSONObject().apply {
            put("type", "set_mode")
            put("mode", mode)
        }
        webSocket?.send(msg.toString())
    }

    fun requestHistory(channel: String, limit: Int = 50, before: Long? = null) {
        val msg = JSONObject().apply {
            put("type", "history")
            put("channel", channel)
            put("limit", limit)
            if (before != null) put("before", before)
        }
        webSocket?.send(msg.toString())
    }

    val isConnected: Boolean get() = connected

    // --- Private ---

    private fun handleMessage(json: JSONObject) {
        when (json.getString("type")) {
            "auth_result" -> {
                if (json.getBoolean("success")) {
                    connected = true
                    listener?.onConnected()
                } else {
                    listener?.onError("Auth failed: ${json.optString("error")}")
                }
            }

            "channel_list" -> {
                val channels = parseChannelList(json.getJSONArray("channels"))
                val mode = json.optString("mode", "desktop")
                listener?.onChannelList(channels, mode)
            }

            "mode_changed" -> {
                val mode = json.getString("mode")
                listener?.onModeChanged(mode)
            }

            "channel_update" -> {
                listener?.onChannelUpdate(
                    json.getString("channel"),
                    json.optString("agentStatus", null),
                    if (json.has("pendingPermission")) json.getBoolean("pendingPermission") else null
                )
            }

            "message" -> {
                val msg = parseChatMessage(json)
                listener?.onMessage(msg)
            }

            "history_response" -> {
                val messages = json.getJSONArray("messages").let { arr ->
                    (0 until arr.length()).map { parseChatMessage(arr.getJSONObject(it)) }
                }
                listener?.onHistory(
                    json.getString("channel"),
                    messages,
                    json.getBoolean("hasMore")
                )
            }

            "error" -> listener?.onError(json.getString("message"))
        }
    }

    private fun parseChannelList(arr: JSONArray): List<Channel> {
        return (0 until arr.length()).map { i ->
            val obj = arr.getJSONObject(i)
            Channel(
                id = obj.getString("id"),
                name = obj.getString("name"),
                agentStatus = obj.optString("agentStatus", "idle"),
                unread = obj.optInt("unread", 0),
                pendingPermission = obj.optBoolean("pendingPermission", false)
            )
        }
    }

    private fun parseChatMessage(json: JSONObject): ChatMessage {
        val metadata = json.optJSONObject("metadata")
        val permReq = metadata?.optJSONObject("permissionRequest")
        val needsAttention = metadata?.optBoolean("needsAttention", false) ?: false

        return ChatMessage(
            id = json.getLong("id"),
            channel = json.getString("channel"),
            sender = json.getString("sender"),
            content = json.getString("content"),
            timestamp = json.getLong("timestamp"),
            needsAttention = needsAttention,
            permissionRequestId = permReq?.optString("requestId"),
            toolName = permReq?.optString("toolName")
        )
    }
}
