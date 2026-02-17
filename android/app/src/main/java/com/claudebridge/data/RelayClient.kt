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
        fun onChannelList(channels: List<Channel>)
        fun onChannelUpdate(channelId: String, agentStatus: String?, pendingPermission: Boolean?)
        fun onPtyOutput(channel: String, data: String, isPermission: Boolean, permissionOptions: List<PermissionOption>, screenText: String)
        fun onBufferSync(channel: String, data: String)
        fun onPing(pingId: String)
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

    /** Send input from phone to PTY proxy via relay. */
    fun sendPtyInput(channel: String, data: String) {
        val msg = JSONObject().apply {
            put("type", "pty_input")
            put("channel", channel)
            put("data", data)
        }
        webSocket?.send(msg.toString())
    }

    /** Ask the relay to remove a channel (manual cleanup from phone). */
    fun removeChannel(channel: String) {
        val msg = JSONObject().apply {
            put("type", "remove_channel")
            put("channel", channel)
        }
        webSocket?.send(msg.toString())
    }

    fun sendPong(pingId: String) {
        val msg = JSONObject().apply {
            put("type", "pong")
            put("pingId", pingId)
        }
        webSocket?.send(msg.toString())
    }

    val isConnected: Boolean get() = connected

    // --- Private ---

    private fun handleMessage(json: JSONObject) {
        when (json.optString("type")) {
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
                listener?.onChannelList(channels)
            }

            "channel_update" -> {
                listener?.onChannelUpdate(
                    json.getString("channel"),
                    json.optString("agentStatus", null),
                    if (json.has("pendingPermission")) json.getBoolean("pendingPermission") else null
                )
            }

            "pty_output" -> {
                val options = mutableListOf<PermissionOption>()
                val optionsArr = json.optJSONArray("permissionOptions")
                if (optionsArr != null) {
                    for (i in 0 until optionsArr.length()) {
                        val opt = optionsArr.getJSONObject(i)
                        options.add(PermissionOption(
                            number = opt.getString("number"),
                            label = opt.getString("label")
                        ))
                    }
                }
                listener?.onPtyOutput(
                    json.getString("channel"),
                    json.getString("data"),
                    json.optBoolean("isPermission", false),
                    options,
                    json.optString("screenText", "")
                )
            }

            "buffer_sync" -> {
                listener?.onBufferSync(
                    json.getString("channel"),
                    json.getString("data")
                )
            }

            "ping" -> {
                val pingId = json.getString("pingId")
                // Auto-respond with pong
                sendPong(pingId)
                listener?.onPing(pingId)
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
                pendingPermission = obj.optBoolean("pendingPermission", false)
            )
        }
    }
}
