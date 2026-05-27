package com.claudebridge.data

data class Channel(
    val id: String,
    val name: String,
    val agentStatus: String = "idle",
    val pendingPermission: Boolean = false
)

/** A numbered option from a Claude Code permission prompt (legacy PTY). */
data class PermissionOption(
    val number: String,
    val label: String
)

// --- SDK Orchestrator message types ---

/** Discriminator for AgentMessage.kind */
object AgentEventKind {
    const val SYSTEM = "system"
    const val ASSISTANT_TEXT = "assistant_text"
    const val TOOL_USE = "tool_use"
    const val TOOL_RESULT = "tool_result"
    const val PERMISSION_REQUEST = "permission_request"
    const val PERMISSION_RESOLVED = "permission_resolved"
    const val THINKING = "thinking"
    const val RESULT = "result"
    const val SESSION_END = "session_end"
}

/**
 * A structured message from the SDK orchestrator.
 * Maps to the `agent_event` relay protocol message.
 */
data class AgentMessage(
    val kind: String,
    val data: Map<String, Any?>,
    val isFinal: Boolean = true,
    val requestId: String? = null,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * A pending permission request that needs user action.
 * Sent as agent_event with kind=permission_request.
 */
data class PermissionRequest(
    val requestId: String,
    val toolName: String,
    val input: Map<String, Any?>,
    /** Non-null if this is an AskUserQuestion with structured options. */
    val questions: List<PermissionQuestion>? = null
)

/** A question within an AskUserQuestion permission request. */
data class PermissionQuestion(
    val question: String,
    val options: List<PermissionQuestionOption>
)

data class PermissionQuestionOption(
    val label: String,
    val description: String
)

// --- Remote control protocol (Android → desktop) ---

/** One entry inside a directory listing returned by the desktop control bot. */
data class DirectoryEntry(
    val name: String,
    val isDir: Boolean
)

/**
 * Response to a list_directory request. allowedRoot empty = desktop hasn't
 * configured a root yet (Android shows a "configure in Chromattica settings"
 * affordance). error non-null = path was rejected or unreadable.
 */
data class DirectoryListing(
    val requestId: String,
    val path: String,
    val allowedRoot: String,
    val entries: List<DirectoryEntry>,
    val parent: String?,
    val error: String?
)

/** A file attachment to send with a user prompt. */
data class FileAttachment(
    val filename: String,
    val mimeType: String,
    /** Base64-encoded file content. */
    val data: String,
    val sizeBytes: Long
) {
    companion object {
        const val MAX_ATTACHMENT_SIZE_BYTES = 10 * 1024 * 1024L // 10MB
    }
}
