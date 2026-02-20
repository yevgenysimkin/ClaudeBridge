package com.claudebridge.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Singleton state holder shared between RelayService (writes) and UI (reads).
 * Structured SDK messages per channel instead of raw terminal buffers.
 */
object BridgeState {
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    private val _channels = MutableStateFlow<List<Channel>>(emptyList())
    val channels: StateFlow<List<Channel>> = _channels

    // channelId → ordered list of structured messages
    private val _messages = MutableStateFlow<Map<String, List<AgentMessage>>>(emptyMap())
    val messages: StateFlow<Map<String, List<AgentMessage>>> = _messages

    // channelId → pending permission request (null if none)
    private val _pendingPermission = MutableStateFlow<Map<String, PermissionRequest>>(emptyMap())
    val pendingPermission: StateFlow<Map<String, PermissionRequest>> = _pendingPermission

    // channelId → in-progress streaming text (not yet finalized)
    private val _streamingText = MutableStateFlow<Map<String, String>>(emptyMap())
    val streamingText: StateFlow<Map<String, String>> = _streamingText

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private const val MAX_MESSAGES_PER_CHANNEL = 500

    fun setConnected(value: Boolean) {
        _connected.value = value
    }

    fun setChannels(list: List<Channel>) {
        _channels.value = list
    }

    fun updateChannel(channelId: String, name: String?, agentStatus: String?, pendingPermission: Boolean?) {
        _channels.value = _channels.value.map { ch ->
            if (ch.id == channelId) {
                ch.copy(
                    name = name ?: ch.name,
                    agentStatus = agentStatus ?: ch.agentStatus,
                    pendingPermission = pendingPermission ?: ch.pendingPermission
                )
            } else ch
        }
    }

    /** Append a structured message to a channel's history. */
    fun appendMessage(channelId: String, message: AgentMessage) {
        val current = _messages.value.toMutableMap()
        val list = (current[channelId] ?: emptyList()).toMutableList()
        list.add(message)
        // Trim oldest if too many
        if (list.size > MAX_MESSAGES_PER_CHANNEL) {
            current[channelId] = list.drop(list.size - MAX_MESSAGES_PER_CHANNEL)
        } else {
            current[channelId] = list
        }
        _messages.value = current
    }

    /** Update streaming text for a channel (non-final assistant_text). */
    fun updateStreamingText(channelId: String, text: String) {
        val current = _streamingText.value.toMutableMap()
        current[channelId] = (current[channelId] ?: "") + text
        _streamingText.value = current
    }

    /** Finalize streaming text: commit as a message and clear the buffer. */
    fun finalizeStreamingText(channelId: String, finalText: String) {
        // Clear streaming buffer
        val current = _streamingText.value.toMutableMap()
        current.remove(channelId)
        _streamingText.value = current

        // Add final message
        if (finalText.isNotBlank()) {
            appendMessage(channelId, AgentMessage(
                kind = AgentEventKind.ASSISTANT_TEXT,
                data = mapOf("text" to finalText),
                isFinal = true
            ))
        }
    }

    /** Set a pending permission request for a channel. */
    fun setPendingPermission(channelId: String, request: PermissionRequest) {
        val current = _pendingPermission.value.toMutableMap()
        current[channelId] = request
        _pendingPermission.value = current
    }

    /** Clear pending permission for a channel. */
    fun clearPendingPermission(channelId: String) {
        val current = _pendingPermission.value.toMutableMap()
        current.remove(channelId)
        _pendingPermission.value = current
    }

    /** Replace all messages for a channel (used for history_sync). */
    fun setMessages(channelId: String, messages: List<AgentMessage>) {
        val current = _messages.value.toMutableMap()
        current[channelId] = if (messages.size > MAX_MESSAGES_PER_CHANNEL) {
            messages.drop(messages.size - MAX_MESSAGES_PER_CHANNEL)
        } else {
            messages
        }
        _messages.value = current
    }

    /** Remove a channel and all its associated state. */
    fun removeChannel(channelId: String) {
        _channels.value = _channels.value.filter { it.id != channelId }
        val msgCurrent = _messages.value.toMutableMap()
        msgCurrent.remove(channelId)
        _messages.value = msgCurrent
        val permCurrent = _pendingPermission.value.toMutableMap()
        permCurrent.remove(channelId)
        _pendingPermission.value = permCurrent
        val streamCurrent = _streamingText.value.toMutableMap()
        streamCurrent.remove(channelId)
        _streamingText.value = streamCurrent
    }

    fun setError(err: String?) {
        _error.value = err
    }

    fun clear() {
        _connected.value = false
        _channels.value = emptyList()
        _messages.value = emptyMap()
        _pendingPermission.value = emptyMap()
        _streamingText.value = emptyMap()
        _error.value = null
    }
}
