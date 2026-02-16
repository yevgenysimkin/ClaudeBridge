package com.claudebridge.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Singleton state holder shared between RelayService (writes) and UI (reads).
 * Terminal buffer per channel instead of discrete chat messages.
 */
object BridgeState {
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected

    private val _channels = MutableStateFlow<List<Channel>>(emptyList())
    val channels: StateFlow<List<Channel>> = _channels

    // channelId → terminal output text buffer
    private val _buffers = MutableStateFlow<Map<String, String>>(emptyMap())
    val buffers: StateFlow<Map<String, String>> = _buffers


    // channelId of channel with active permission prompt
    private val _activePermission = MutableStateFlow<String?>(null)
    val activePermission: StateFlow<String?> = _activePermission

    // Parsed options for the active permission prompt
    private val _permissionOptions = MutableStateFlow<List<PermissionOption>>(emptyList())
    val permissionOptions: StateFlow<List<PermissionOption>> = _permissionOptions

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error

    private const val MAX_BUFFER_SIZE = 100_000 // characters per channel

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
        // Track active permission for UI
        if (pendingPermission == true) {
            _activePermission.value = channelId
        } else if (pendingPermission == false && _activePermission.value == channelId) {
            _activePermission.value = null
        }
    }

    fun appendOutput(channelId: String, text: String) {
        val current = _buffers.value.toMutableMap()
        val existing = current[channelId] ?: ""
        val updated = existing + text
        // Trim from the front if too large
        current[channelId] = if (updated.length > MAX_BUFFER_SIZE) {
            updated.substring(updated.length - MAX_BUFFER_SIZE)
        } else {
            updated
        }
        _buffers.value = current
    }

    fun setBuffer(channelId: String, text: String) {
        val current = _buffers.value.toMutableMap()
        current[channelId] = if (text.length > MAX_BUFFER_SIZE) {
            text.substring(text.length - MAX_BUFFER_SIZE)
        } else {
            text
        }
        _buffers.value = current
    }

    fun setActivePermission(channelId: String?) {
        _activePermission.value = channelId
        if (channelId == null) {
            _permissionOptions.value = emptyList()
        }
    }

    fun setPermissionOptions(options: List<PermissionOption>) {
        _permissionOptions.value = options
    }

    // channelId → display text (write-once, clearable)
    private val _displayBuffers = MutableStateFlow<Map<String, String>>(emptyMap())
    val displayBuffers: StateFlow<Map<String, String>> = _displayBuffers

    // channelId → set of message hashes we've already written (never cleared)
    private val seenHashes = mutableMapOf<String, MutableSet<String>>()

    /** Try to append a message. Returns true if it was new (not seen before). */
    fun appendIfNew(channelId: String, message: String): Boolean {
        val hash = message.hashCode().toString()
        val seen = seenHashes.getOrPut(channelId) { mutableSetOf() }
        if (!seen.add(hash)) return false // already seen

        val current = _displayBuffers.value.toMutableMap()
        val existing = current[channelId] ?: ""
        current[channelId] = if (existing.isBlank()) message else "$existing\n\n$message"
        _displayBuffers.value = current
        return true
    }

    /** Clear display buffer. Seen hashes are kept so old messages stay suppressed. */
    fun clearBuffer(channelId: String) {
        val current = _displayBuffers.value.toMutableMap()
        current[channelId] = ""
        _displayBuffers.value = current
    }

    fun setError(err: String?) {
        _error.value = err
    }

    fun clear() {
        _connected.value = false
        _channels.value = emptyList()
        _buffers.value = emptyMap()
        _activePermission.value = null
        _permissionOptions.value = emptyList()
        _error.value = null
    }
}
