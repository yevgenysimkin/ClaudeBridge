package com.claudebridge.data

data class Channel(
    val id: String,
    val name: String,
    val agentStatus: String = "idle",
    val pendingPermission: Boolean = false
)

/** A numbered option from a Claude Code permission prompt. */
data class PermissionOption(
    val number: String,
    val label: String
)
