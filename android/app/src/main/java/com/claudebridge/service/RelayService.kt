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
            ACTION_PERMISSION_RESPONSE -> {
                val channel = intent.getStringExtra(EXTRA_CHANNEL) ?: return START_NOT_STICKY
                val requestId = intent.getStringExtra(EXTRA_REQUEST_ID) ?: return START_NOT_STICKY
                val behavior = intent.getStringExtra(EXTRA_BEHAVIOR) ?: return START_NOT_STICKY
                relayClient?.sendPermissionResponse(channel, requestId, behavior)
                BridgeState.clearPendingPermission(channel)
                // Dismiss the notification
                val nm = getSystemService(NotificationManager::class.java)
                nm.cancel(NOTIFICATION_ID_ATTENTION_BASE + channel.hashCode())
            }
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        disconnect()
        super.onDestroy()
    }

    // --- Public API (via binder) ---

    fun sendUserPrompt(channel: String, text: String) {
        relayClient?.sendUserPrompt(channel, text)
    }

    fun sendPermissionResponse(channel: String, requestId: String, behavior: String, answers: Map<String, String>? = null) {
        relayClient?.sendPermissionResponse(channel, requestId, behavior, answers)
    }

    fun removeChannel(channel: String) {
        relayClient?.removeChannel(channel)
    }

    fun renameChannel(channel: String, name: String) {
        relayClient?.renameChannel(channel, name)
    }

    fun sendInterruptRequest(channel: String) {
        relayClient?.sendInterruptRequest(channel)
    }

    fun sendUserPromptWithAttachments(channel: String, text: String, attachments: List<FileAttachment>) {
        relayClient?.sendUserPromptWithAttachments(channel, text, attachments)
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

    override fun onChannelUpdate(channelId: String, name: String?, agentStatus: String?, pendingPermission: Boolean?) {
        BridgeState.updateChannel(channelId, name, agentStatus, pendingPermission)
    }

    override fun onAgentEvent(channel: String, message: AgentMessage) {
        when (message.kind) {
            AgentEventKind.ASSISTANT_TEXT -> {
                if (message.isFinal) {
                    val text = message.data["text"] as? String ?: ""
                    BridgeState.finalizeStreamingText(channel, text)
                } else {
                    val text = message.data["text"] as? String ?: ""
                    BridgeState.updateStreamingText(channel, text)
                }
            }

            AgentEventKind.PERMISSION_REQUEST -> {
                val requestId = message.requestId ?: return
                val toolName = message.data["toolName"] as? String ?: "unknown"

                @Suppress("UNCHECKED_CAST")
                val input = (message.data["input"] as? Map<String, Any?>) ?: emptyMap()

                // Parse questions if present (AskUserQuestion)
                @Suppress("UNCHECKED_CAST")
                val questionsRaw = message.data["questions"] as? List<Map<String, Any?>>
                val questions = questionsRaw?.map { q ->
                    @Suppress("UNCHECKED_CAST")
                    val optionsRaw = q["options"] as? List<Map<String, Any?>> ?: emptyList()
                    PermissionQuestion(
                        question = q["question"] as? String ?: "",
                        options = optionsRaw.map { opt ->
                            PermissionQuestionOption(
                                label = opt["label"] as? String ?: "",
                                description = opt["description"] as? String ?: ""
                            )
                        }
                    )
                }

                val request = PermissionRequest(
                    requestId = requestId,
                    toolName = toolName,
                    input = input,
                    questions = questions
                )
                BridgeState.setPendingPermission(channel, request)
                BridgeState.appendMessage(channel, message)
                fireAttentionNotification(channel, "Permission: $toolName", requestId)
            }

            AgentEventKind.PERMISSION_RESOLVED -> {
                BridgeState.clearPendingPermission(channel)
                BridgeState.appendMessage(channel, message)
            }

            else -> {
                // All other event kinds: just append to message history
                BridgeState.appendMessage(channel, message)
            }
        }
    }

    override fun onHistorySync(channel: String, messages: List<AgentMessage>) {
        BridgeState.setMessages(channel, messages)
        // Check if there's an unresolved permission in history
        val lastPermission = messages.lastOrNull { it.kind == AgentEventKind.PERMISSION_REQUEST }
        val lastResolved = messages.lastOrNull { it.kind == AgentEventKind.PERMISSION_RESOLVED }
        if (lastPermission != null && (lastResolved == null || lastPermission.timestamp > lastResolved.timestamp)) {
            val requestId = lastPermission.requestId
            if (requestId != null) {
                @Suppress("UNCHECKED_CAST")
                val toolName = lastPermission.data["toolName"] as? String ?: "unknown"

                @Suppress("UNCHECKED_CAST")
                val input = (lastPermission.data["input"] as? Map<String, Any?>) ?: emptyMap()
                BridgeState.setPendingPermission(channel, PermissionRequest(requestId, toolName, input))
            }
        }
    }

    override fun onPing(pingId: String) {
        // Pong is auto-sent by RelayClient
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

    private fun fireAttentionNotification(channel: String, summary: String, requestId: String? = null) {
        val tapIntent = Intent(this, MainActivity::class.java).apply {
            putExtra(EXTRA_CHANNEL, channel)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pendingTap = PendingIntent.getActivity(
            this, channel.hashCode(), tapIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(this, ClaudeBridgeApp.CHANNEL_ATTENTION)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Permission Request")
            .setContentText(summary.take(200))
            .setContentIntent(pendingTap)
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)

        // Add Allow/Deny action buttons if we have a requestId
        if (requestId != null) {
            val allowIntent = Intent(this, RelayService::class.java).apply {
                action = ACTION_PERMISSION_RESPONSE
                putExtra(EXTRA_CHANNEL, channel)
                putExtra(EXTRA_REQUEST_ID, requestId)
                putExtra(EXTRA_BEHAVIOR, "allow")
            }
            val allowPending = PendingIntent.getService(
                this, ("allow-$channel-$requestId").hashCode(), allowIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            val denyIntent = Intent(this, RelayService::class.java).apply {
                action = ACTION_PERMISSION_RESPONSE
                putExtra(EXTRA_CHANNEL, channel)
                putExtra(EXTRA_REQUEST_ID, requestId)
                putExtra(EXTRA_BEHAVIOR, "deny")
            }
            val denyPending = PendingIntent.getService(
                this, ("deny-$channel-$requestId").hashCode(), denyIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )

            builder.addAction(0, "Allow", allowPending)
            builder.addAction(0, "Deny", denyPending)
        }

        val nm = getSystemService(NotificationManager::class.java)
        nm.notify(NOTIFICATION_ID_ATTENTION_BASE + channel.hashCode(), builder.build())
    }

    companion object {
        const val ACTION_CONNECT = "com.claudebridge.CONNECT"
        const val ACTION_DISCONNECT = "com.claudebridge.DISCONNECT"
        const val ACTION_PERMISSION_RESPONSE = "com.claudebridge.PERMISSION_RESPONSE"
        const val EXTRA_URL = "url"
        const val EXTRA_TOKEN = "token"
        const val EXTRA_CHANNEL = "channel"
        const val EXTRA_REQUEST_ID = "requestId"
        const val EXTRA_BEHAVIOR = "behavior"
        private const val NOTIFICATION_ID_CONNECTION = 1
        private const val NOTIFICATION_ID_ATTENTION_BASE = 1000
    }
}
