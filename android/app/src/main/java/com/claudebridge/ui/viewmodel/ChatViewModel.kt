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
 * ViewModel for the chat UI. Binds to RelayService and delegates
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

        // Also bind so we can call methods
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
        if (channelId != null) {
            service?.requestHistory(channelId)
        }
    }

    fun sendMessage(content: String) {
        val channel = _currentChannel.value ?: return
        service?.sendMessage(channel, content)
    }

    fun approvePermission(channel: String, requestId: String) {
        service?.sendPermissionResponse(channel, requestId, approved = true)
    }

    fun denyPermission(channel: String, requestId: String, reason: String? = null) {
        service?.sendPermissionResponse(channel, requestId, approved = false, message = reason)
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
