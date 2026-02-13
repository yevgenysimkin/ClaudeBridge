package com.claudebridge.data

data class Channel(
    val id: String,
    val name: String,
    val agentStatus: String = "idle",
    val unread: Int = 0,
    val pendingPermission: Boolean = false
)

data class ChatMessage(
    val id: Long,
    val channel: String,
    val sender: String,       // "bot", "user", "system"
    val content: String,
    val timestamp: Long,
    val needsAttention: Boolean = false,
    val permissionRequestId: String? = null,
    val toolName: String? = null
)
