package com.claudebridge.service

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.Binder
import android.os.IBinder
import androidx.core.app.NotificationCompat
import com.claudebridge.ClaudeBridgeApp
import com.claudebridge.MainActivity
import com.claudebridge.R
import com.claudebridge.data.*

/**
 * Foreground service that keeps the WebSocket connection alive.
 * Owns the RelayClient, pushes state into BridgeState,
 * and fires attention notifications for permission requests.
 */
class RelayService : Service(), RelayClient.Listener {

    inner class LocalBinder : Binder() {
        val service: RelayService get() = this@RelayService
    }

    private val binder = LocalBinder()
    private var relayClient: RelayClient? = null

    override fun onBind(intent: Intent?): IBinder = binder

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_CONNECT -> {
                val url = intent.getStringExtra(EXTRA_URL) ?: return START_NOT_STICKY
                val token = intent.getStringExtra(EXTRA_TOKEN) ?: return START_NOT_STICKY
                startForeground(NOTIFICATION_ID_CONNECTION, buildConnectionNotification("Connecting..."))
                connect(url, token)
            }
            ACTION_DISCONNECT -> {
                disconnect()
                stopForeground(STOP_FOREGROUND_REMOVE)
                stopSelf()
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        disconnect()
        super.onDestroy()
    }

    // --- Public API (via binder) ---

    fun sendPtyInput(channel: String, data: String) {
        relayClient?.sendPtyInput(channel, data)
    }

    fun removeChannel(channel: String) {
        relayClient?.removeChannel(channel)
    }

    val isConnected: Boolean get() = relayClient?.isConnected ?: false

    // --- RelayClient.Listener ---

    override fun onConnected() {
        BridgeState.setConnected(true)
        BridgeState.setError(null)
        updateConnectionNotification("Connected")
    }

    override fun onDisconnected() {
        BridgeState.setConnected(false)
        updateConnectionNotification("Disconnected")
    }

    override fun onChannelList(channels: List<Channel>) {
        BridgeState.setChannels(channels)
    }

    override fun onChannelUpdate(channelId: String, agentStatus: String?, pendingPermission: Boolean?) {
        BridgeState.updateChannel(channelId, agentStatus, pendingPermission)
    }

    override fun onPtyOutput(channel: String, data: String, isPermission: Boolean, permissionOptions: List<PermissionOption>, screenText: String) {
        BridgeState.appendOutput(channel, data)
        if (screenText.isNotEmpty()) {
            BridgeState.setScreenText(channel, screenText)
        }
        if (isPermission) {
            BridgeState.setActivePermission(channel)
            if (permissionOptions.isNotEmpty()) {
                BridgeState.setPermissionOptions(permissionOptions)
            }
            fireAttentionNotification(channel, data)
        } else if (BridgeState.activePermission.value == channel) {
            // Question was answered from the local terminal — clear permission UI
            BridgeState.setActivePermission(null)
        }
    }

    override fun onBufferSync(channel: String, data: String) {
        BridgeState.setBuffer(channel, data)
    }

    override fun onPing(pingId: String) {
        // Pong is auto-sent by RelayClient — nothing to do here
    }

    override fun onError(error: String) {
        BridgeState.setError(error)
    }

    // --- Private ---

    private fun connect(url: String, token: String) {
        disconnect()
        relayClient = RelayClient(url, token).also {
            it.listener = this
            it.connect()
        }
    }

    private fun disconnect() {
        relayClient?.disconnect()
        relayClient = null
        BridgeState.setConnected(false)
    }

    private fun buildConnectionNotification(status: String): Notification {
        val tapIntent = Intent(this, MainActivity::class.java)
        val pendingTap = PendingIntent.getActivity(
            this, 0, tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, ClaudeBridgeApp.CHANNEL_CONNECTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("ClaudeBridge")
            .setContentText(status)
            .setContentIntent(pendingTap)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun updateConnectionNotification(status: String) {
        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID_CONNECTION, buildConnectionNotification(status))
    }

    private fun fireAttentionNotification(channel: String, data: String) {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_CHANNEL, channel)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingTap = PendingIntent.getActivity(
            this, channel.hashCode(), tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, ClaudeBridgeApp.CHANNEL_ATTENTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Permission Request")
            .setContentText(data.take(200))
            .setContentIntent(pendingTap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .build()

        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID_ATTENTION_BASE + channel.hashCode(), notification)
    }

    companion object {
        const val ACTION_CONNECT = "com.claudebridge.CONNECT"
        const val ACTION_DISCONNECT = "com.claudebridge.DISCONNECT"
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_CHANNEL = "channel"
        private const val NOTIFICATION_ID_CONNECTION = 1
        private const val NOTIFICATION_ID_ATTENTION_BASE = 1000
    }
}
