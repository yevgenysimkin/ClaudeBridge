package com.claudebridge.ui.viewmodel

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import com.claudebridge.data.BridgeState
import com.claudebridge.data.Preferences
import com.claudebridge.service.RelayService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * ViewModel for the message UI. Binds to RelayService and delegates
 * all state observation to BridgeState.
 */
class ChatViewModel(application: Application) : AndroidViewModel(application) {

    private val prefs = Preferences(application)
    private var service: RelayService? = null
    private var bound = false
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _currentChannel = MutableStateFlow<String?>(null)
    val currentChannel: StateFlow<String?> = _currentChannel

    // Delegate to BridgeState
    val connected = BridgeState.connected
    val channels = BridgeState.channels
    val messages = BridgeState.messages
    val pendingPermission = BridgeState.pendingPermission
    val streamingText = BridgeState.streamingText
    val error = BridgeState.error
    val allowedRoot = BridgeState.allowedRoot
    val currentDirListing = BridgeState.currentDirListing
    val modelManifest = BridgeState.modelManifest

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName?, binder: IBinder?) {
            service = (binder as RelayService.LocalBinder).service
            bound = true
        }

        override fun onServiceDisconnected(name: ComponentName?) {
            service = null
            bound = false
        }
    }

    fun startConnection() {
        if (!prefs.isConfigured) return
        val ctx = getApplication<Application>()

        val intent = Intent(ctx, RelayService::class.java).apply {
            action = RelayService.ACTION_CONNECT
            putExtra(RelayService.EXTRA_URL, prefs.relayUrl)
            putExtra(RelayService.EXTRA_TOKEN, prefs.authToken)
        }
        ctx.startForegroundService(intent)

        ctx.bindService(
            Intent(ctx, RelayService::class.java),
            connection,
            Context.BIND_AUTO_CREATE
        )
    }

    fun stopConnection() {
        val ctx = getApplication<Application>()
        val intent = Intent(ctx, RelayService::class.java).apply {
            action = RelayService.ACTION_DISCONNECT
        }
        ctx.startService(intent)
        unbind()
        BridgeState.clear()
    }

    fun selectChannel(channelId: String?) {
        _currentChannel.value = channelId
    }

    /** Send a user prompt to the orchestrator. */
    fun sendPrompt(text: String) {
        val channel = _currentChannel.value ?: return
        service?.sendUserPrompt(channel, text)
        // Add user message to local state immediately for feedback
        BridgeState.appendMessage(channel, com.claudebridge.data.AgentMessage(
            kind = "user_prompt",
            data = mapOf("text" to text),
            isFinal = true
        ))
    }

    /** Respond to a permission request. */
    fun respondToPermission(channel: String, requestId: String, behavior: String, answers: Map<String, String>? = null) {
        service?.sendPermissionResponse(channel, requestId, behavior, answers)
        BridgeState.clearPendingPermission(channel)
    }

    /** Rename a channel (sends rename to relay, updates local state). */
    fun renameChannel(channelId: String, newName: String) {
        service?.renameChannel(channelId, newName)
        BridgeState.updateChannel(channelId, name = newName, agentStatus = null, pendingPermission = null)
    }

    /** Remove a channel from the relay (manual cleanup). */
    fun removeChannel(channelId: String) {
        service?.removeChannel(channelId)
        BridgeState.removeChannel(channelId)
        if (_currentChannel.value == channelId) {
            _currentChannel.value = null
        }
    }

    fun refresh() {
        stopConnection()
        startConnection()
    }

    // --- Remote-control API ---

    /** Ask the desktop control bot for a directory listing under the allowed root. */
    fun listDirectory(path: String?) {
        service?.listDirectory(java.util.UUID.randomUUID().toString(), path)
    }

    /** Ask the desktop for its live model/effort catalog (NewSessionSheet open). */
    fun requestModels() {
        service?.listModels(java.util.UUID.randomUUID().toString())
    }

    /**
     * Provoke a new CB session on the connected desktop. Resolves the
     * callback with (channelId, error) — one of them will be non-null.
     * Returns the requestId so the caller can cancel the in-flight request
     * (timeout, dismiss) without leaving a stale callback that would fire
     * late and surprise the user.
     */
    fun remoteStartSession(
        projectDir: String,
        model: String?,
        effort: String?,
        skipPermissions: Boolean,
        onResolved: (channelId: String?, error: String?) -> Unit
    ): String {
        val svc = service ?: run {
            onResolved(null, "Not connected to relay service")
            return ""
        }
        val requestId = java.util.UUID.randomUUID().toString()
        // The relay reply arrives on OkHttp's IO thread. The caller's callback
        // touches Compose state and navController.navigate(), both of which
        // require the main thread — so marshal there before invoking.
        BridgeState.registerStartRequest(requestId) { chId, err ->
            mainHandler.post { onResolved(chId, err) }
        }
        svc.remoteStartSession(requestId, projectDir, model, effort, skipPermissions)
        return requestId
    }

    /** Cancel a pending remote-start request (timeout, dismiss). */
    fun cancelStartRequest(requestId: String) {
        if (requestId.isEmpty()) return
        BridgeState.clearStartRequest(requestId)
    }

    private fun unbind() {
        if (bound) {
            try {
                getApplication<Application>().unbindService(connection)
            } catch (_: Exception) { }
            bound = false
        }
    }

    override fun onCleared() {
        unbind()
        super.onCleared()
    }
}
