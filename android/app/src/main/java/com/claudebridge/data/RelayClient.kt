package com.claudebridge.data

import android.util.Log
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
        fun onChannelUpdate(channelId: String, name: String?, agentStatus: String?, pendingPermission: Boolean?)
        fun onAgentEvent(channel: String, message: AgentMessage)
        fun onHistorySync(channel: String, messages: List<AgentMessage>)
        fun onPing(pingId: String)
        fun onError(error: String)
        /** Called when relay auth fails. Service can refresh token and call retryAuth(). */
        fun onAuthFailed(error: String) {}
        /** Remote-control: directory listing reply from the desktop control bot. */
        fun onDirectoryListing(listing: DirectoryListing) {}
        /** Remote-control: response to a remote_start_session request. */
        fun onRemoteSessionStarted(requestId: String, channelId: String?, error: String?) {}
        /** Remote-control: the desktop's live model/effort catalog. */
        fun onModelManifest(manifest: ModelManifest) {}
    }

    var listener: Listener? = null
    private var webSocket: WebSocket? = null
    private var connected = false
    private var authRetried = false
    // readTimeout=0 → no idle close: WebSocket frames can be sparse, and we
    // already keep the connection alive via OkHttp's pingInterval. The default
    // 10s readTimeout was almost certainly responsible for our 2-second flap.
    private val client = OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .build()

    fun connect() {
        val wsUrl = relayUrl.replace("https://", "wss://").replace("http://", "ws://")
        val request = Request.Builder().url(wsUrl).build()

        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                Log.d(TAG, "WS onOpen")
                val auth = JSONObject().apply {
                    put("type", "auth")
                    put("token", authToken)
                    put("clientType", "app")
                }
                webSocket.send(auth.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                try {
                    handleMessage(JSONObject(text))
                } catch (e: Exception) {
                    // Swallow parse errors so a malformed broadcast doesn't
                    // bubble out of onMessage and tear the WS down.
                    Log.w(TAG, "WS message parse failed: ${e.message} (text head: ${text.take(120)})")
                }
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                Log.d(TAG, "WS onClosing code=$code reason=$reason")
                webSocket.close(1000, null)
                connected = false
                listener?.onDisconnected()
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "WS onFailure ${t::class.java.simpleName}: ${t.message} (httpCode=${response?.code})")
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

    /** Send a user prompt to the orchestrator via relay. */
    fun sendUserPrompt(channel: String, text: String) {
        val msg = JSONObject().apply {
            put("type", "user_prompt")
            put("channel", channel)
            put("text", text)
        }
        webSocket?.send(msg.toString())
    }

    /** Send a permission response (allow/deny) to the orchestrator. */
    fun sendPermissionResponse(
        channel: String,
        requestId: String,
        behavior: String,
        answers: Map<String, String>? = null
    ) {
        val msg = JSONObject().apply {
            put("type", "permission_response")
            put("channel", channel)
            put("requestId", requestId)
            put("behavior", behavior)
            if (answers != null) {
                put("answers", JSONObject(answers))
            }
        }
        webSocket?.send(msg.toString())
    }

    /** Send interrupt request to abort the current agent turn. */
    fun sendInterruptRequest(channel: String) {
        val msg = JSONObject().apply {
            put("type", "interrupt_request")
            put("channel", channel)
            put("timestamp", System.currentTimeMillis())
        }
        webSocket?.send(msg.toString())
    }

    /** Send a user prompt with file attachments. */
    fun sendUserPromptWithAttachments(
        channel: String,
        text: String,
        attachments: List<FileAttachment>
    ) {
        val msg = JSONObject().apply {
            put("type", "user_prompt")
            put("channel", channel)
            put("text", text)
            put("timestamp", System.currentTimeMillis())
            val arr = JSONArray()
            for (att in attachments) {
                arr.put(JSONObject().apply {
                    put("filename", att.filename)
                    put("mimeType", att.mimeType)
                    put("data", att.data)
                    put("sizeBytes", att.sizeBytes)
                })
            }
            put("attachments", arr)
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

    /** Rename a channel (sends rename_channel to relay). */
    fun renameChannel(channel: String, name: String) {
        val msg = JSONObject().apply {
            put("type", "rename_channel")
            put("channel", channel)
            put("name", name)
        }
        webSocket?.send(msg.toString())
    }

    /** Ask the desktop control bot for a directory listing under the allowed root. */
    fun sendListDirectory(requestId: String, path: String?) {
        val msg = JSONObject().apply {
            put("type", "list_directory")
            put("requestId", requestId)
            if (path != null) put("path", path)
            put("timestamp", System.currentTimeMillis())
        }
        webSocket?.send(msg.toString())
    }

    /** Ask the desktop control bot for its live model/effort catalog. */
    fun sendListModels(requestId: String) {
        val msg = JSONObject().apply {
            put("type", "list_models")
            put("requestId", requestId)
            put("timestamp", System.currentTimeMillis())
        }
        webSocket?.send(msg.toString())
    }

    /** Provoke a new CB session on the connected desktop. */
    fun sendRemoteStartSession(
        requestId: String,
        projectDir: String,
        model: String?,
        effort: String?,
        skipPermissions: Boolean
    ) {
        val msg = JSONObject().apply {
            put("type", "remote_start_session")
            put("requestId", requestId)
            put("projectDir", projectDir)
            if (model != null) put("model", model)
            if (!effort.isNullOrEmpty()) put("effort", effort)
            put("skipPermissions", skipPermissions)
            put("timestamp", System.currentTimeMillis())
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

    /** Retry auth with a new token (e.g., after config refresh). Limit: 1 retry. */
    fun retryAuth(newToken: String) {
        if (authRetried) return
        authRetried = true
        val auth = JSONObject().apply {
            put("type", "auth")
            put("token", newToken)
            put("clientType", "app")
        }
        webSocket?.send(auth.toString())
    }

    val isConnected: Boolean get() = connected

    companion object {
        private const val TAG = "RelayClient"
    }

    // --- Private ---

    private fun handleMessage(json: JSONObject) {
        when (json.optString("type")) {
            "auth_result" -> {
                if (json.getBoolean("success")) {
                    connected = true
                    authRetried = false
                    listener?.onConnected()
                } else {
                    val error = json.optString("error", "unknown")
                    listener?.onAuthFailed(error)
                }
            }

            "channel_list" -> {
                val channels = parseChannelList(json.getJSONArray("channels"))
                listener?.onChannelList(channels)
            }

            "channel_update" -> {
                listener?.onChannelUpdate(
                    json.getString("channel"),
                    if (json.has("name")) json.getString("name") else null,
                    json.optString("agentStatus", null),
                    if (json.has("pendingPermission")) json.getBoolean("pendingPermission") else null
                )
            }

            "agent_event" -> {
                val channel = json.getString("channel")
                val message = parseAgentEvent(json)
                listener?.onAgentEvent(channel, message)
            }

            "history_sync" -> {
                val channel = json.getString("channel")
                val eventsArr = json.getJSONArray("events")
                val messages = (0 until eventsArr.length()).mapNotNull { i ->
                    try {
                        parseAgentEvent(eventsArr.getJSONObject(i))
                    } catch (_: Exception) { null }
                }
                listener?.onHistorySync(channel, messages)
            }

            "ping" -> {
                val pingId = json.getString("pingId")
                sendPong(pingId)
                listener?.onPing(pingId)
            }

            "directory_listing" -> {
                val entriesArr = json.optJSONArray("entries") ?: JSONArray()
                val entries = (0 until entriesArr.length()).map { i ->
                    val obj = entriesArr.getJSONObject(i)
                    DirectoryEntry(
                        name = obj.getString("name"),
                        isDir = obj.optBoolean("isDir", false)
                    )
                }
                listener?.onDirectoryListing(
                    DirectoryListing(
                        requestId   = json.getString("requestId"),
                        path        = json.optString("path", ""),
                        allowedRoot = json.optString("allowedRoot", ""),
                        entries     = entries,
                        parent      = if (json.has("parent")) json.getString("parent") else null,
                        error       = if (json.has("error")) json.getString("error") else null
                    )
                )
            }

            "remote_session_started" -> {
                val reqId = json.optString("requestId", "")
                val chId  = if (json.has("channelId")) json.getString("channelId") else null
                val err   = if (json.has("error")) json.getString("error") else null
                Log.d(TAG, "remote_session_started reqId=$reqId chId=$chId err=$err")
                listener?.onRemoteSessionStarted(reqId, chId, err)
            }

            "model_manifest" -> {
                val modelsArr = json.optJSONArray("models") ?: JSONArray()
                val models = (0 until modelsArr.length()).map { i ->
                    val obj = modelsArr.getJSONObject(i)
                    val levelsArr = obj.optJSONArray("effortLevels") ?: JSONArray()
                    ModelManifestEntry(
                        id = obj.getString("id"),
                        label = obj.optString("label", obj.getString("id")),
                        effortLevels = (0 until levelsArr.length()).map { levelsArr.getString(it) }
                    )
                }
                listener?.onModelManifest(
                    ModelManifest(
                        requestId = json.optString("requestId", ""),
                        models = models,
                        defaultModel = json.optString("defaultModel", "")
                    )
                )
            }

            "error" -> listener?.onError(json.getString("message"))
        }
    }

    private fun parseAgentEvent(json: JSONObject): AgentMessage {
        val kind = json.getString("kind")
        val dataObj = json.optJSONObject("data")
        val data = if (dataObj != null) jsonObjectToMap(dataObj) else emptyMap()
        val isFinal = json.optBoolean("isFinal", true)
        val requestId = json.optString("requestId", null)

        return AgentMessage(
            kind = kind,
            data = data,
            isFinal = isFinal,
            requestId = requestId
        )
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

    /** Convert a JSONObject to a Map<String, Any?> recursively. */
    private fun jsonObjectToMap(obj: JSONObject): Map<String, Any?> {
        val map = mutableMapOf<String, Any?>()
        for (key in obj.keys()) {
            map[key] = jsonValueToKotlin(obj.get(key))
        }
        return map
    }

    private fun jsonValueToKotlin(value: Any?): Any? {
        return when (value) {
            is JSONObject -> jsonObjectToMap(value)
            is JSONArray -> (0 until value.length()).map { jsonValueToKotlin(value.get(it)) }
            JSONObject.NULL -> null
            else -> value
        }
    }
}
