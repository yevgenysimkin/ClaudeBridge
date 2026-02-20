package com.claudebridge.ui.viewmodel

import android.app.Application
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
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

    private val _currentChannel = MutableStateFlow<String?>(null)
    val currentChannel: StateFlow<String?> = _currentChannel

    // Delegate to BridgeState
    val connected = BridgeState.connected
    val channels = BridgeState.channels
    val messages = BridgeState.messages
    val pendingPermission = BridgeState.pendingPermission
    val streamingText = BridgeState.streamingText
    val error = BridgeState.error

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
