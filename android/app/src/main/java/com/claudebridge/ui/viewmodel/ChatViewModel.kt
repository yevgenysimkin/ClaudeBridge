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
 * ViewModel for the terminal UI. Binds to RelayService and delegates
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
    val buffers = BridgeState.buffers
    val activePermission = BridgeState.activePermission
    val permissionOptions = BridgeState.permissionOptions
    val displayBuffers = BridgeState.displayBuffers
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

    /** Send text input from phone to the PTY proxy. */
    fun sendInput(text: String) {
        val channel = _currentChannel.value ?: return
        service?.sendPtyInput(channel, text + "\n")
    }

    /** Send raw keystrokes (e.g., "y\n" for permission approval). */
    fun sendRaw(channel: String, data: String) {
        service?.sendPtyInput(channel, data)
        BridgeState.setActivePermission(null)
    }

    /** Select a numbered permission option (sends the digit + newline). */
    fun selectOption(channel: String, optionNumber: String) {
        service?.sendPtyInput(channel, "$optionNumber\n")
        BridgeState.setActivePermission(null)
    }

    /** Send ESC key to interrupt Claude. */
    fun sendEsc(channel: String) {
        service?.sendPtyInput(channel, "\u001b")
    }

    /** Clear the display buffer. Old messages stay suppressed via seen hashes. */
    fun clearBuffer(channel: String) {
        BridgeState.clearBuffer(channel)
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
