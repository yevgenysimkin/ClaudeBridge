package com.claudebridge.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Singleton state holder shared between RelayService (writes) and UI (reads).
 * Not a god object — just a reactive state bus. The service owns the RelayClient
 * and pushes state here; the ViewModel observes it.
 */
object BridgeState {
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    private val _channels = MutableStateFlow<List<Channel>>(emptyList())
    val channels: StateFlow<List<Channel>> = _channels

    // channelId → messages (newest last)
    private val _messages = MutableStateFlow<Map<String, List<ChatMessage>>>(emptyMap())
    val messages: StateFlow<Map<String, List<ChatMessage>>> = _messages

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    fun setConnected(value: Boolean) {
        _connected.value = value
    }

    fun setChannels(list: List<Channel>) {
        _channels.value = list
    }

    fun updateChannel(channelId: String, agentStatus: String?, pendingPermission: Boolean?) {
        _channels.value = _channels.value.map { ch ->
            if (ch.id == channelId) {
                ch.copy(
                    agentStatus = agentStatus ?: ch.agentStatus,
                    pendingPermission = pendingPermission ?: ch.pendingPermission
                )
            } else ch
        }
    }

    fun addMessage(msg: ChatMessage) {
        val current = _messages.value.toMutableMap()
        val channelMsgs = current[msg.channel]?.toMutableList() ?: mutableListOf()
        // Avoid duplicates
        if (channelMsgs.none { it.id == msg.id }) {
            channelMsgs.add(msg)
            current[msg.channel] = channelMsgs
            _messages.value = current
        }
    }

    fun setHistory(channelId: String, msgs: List<ChatMessage>) {
        val current = _messages.value.toMutableMap()
        current[channelId] = msgs
        _messages.value = current
    }

    fun prependHistory(channelId: String, older: List<ChatMessage>) {
        val current = _messages.value.toMutableMap()
        val existing = current[channelId] ?: emptyList()
        current[channelId] = older + existing
        _messages.value = current
    }

    fun setError(err: String?) {
        _error.value = err
    }

    fun clear() {
        _connected.value = false
        _channels.value = emptyList()
        _messages.value = emptyMap()
        _error.value = null
    }
}
