package com.claudebridge.ui.screen

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.AttachFile
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import android.util.Base64
import com.claudebridge.data.AgentEventKind
import com.claudebridge.data.AgentMessage
import com.claudebridge.data.FileAttachment
import com.claudebridge.data.PermissionRequest
import com.claudebridge.ui.theme.*
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessageScreen(
    channelName: String,
    channelId: String,
    messages: List<AgentMessage>,
    streamingText: String,
    pendingPermission: PermissionRequest?,
    isAgentRunning: Boolean = false,
    onBack: () -> Unit,
    onSendPrompt: (String) -> Unit,
    onSendWithAttachments: ((String, List<FileAttachment>) -> Unit)? = null,
    onInterrupt: (() -> Unit)? = null,
    onPermissionResponse: (requestId: String, behavior: String, answers: Map<String, String>?) -> Unit,
    onRename: (String) -> Unit
) {
    var inputText by remember { mutableStateOf("") }
    var showRenameDialog by remember { mutableStateOf(false) }
    var pendingAttachments by remember { mutableStateOf<List<FileAttachment>>(emptyList()) }
    val listState = rememberLazyListState()
    val coroutineScope = rememberCoroutineScope()
    val context = LocalContext.current

    // File picker launcher
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetMultipleContents()
    ) { uris: List<Uri> ->
        val attachments = uris.mapNotNull { uri ->
            try {
                val resolver = context.contentResolver
                val mimeType = resolver.getType(uri) ?: "application/octet-stream"
                val filename = uri.lastPathSegment ?: "file"
                val bytes = resolver.openInputStream(uri)?.use { input ->
                    val buffer = ByteArrayOutputStream()
                    input.copyTo(buffer)
                    buffer.toByteArray()
                } ?: return@mapNotNull null

                if (bytes.size > FileAttachment.MAX_ATTACHMENT_SIZE_BYTES) {
                    return@mapNotNull null // Skip oversized files
                }

                FileAttachment(
                    filename = filename,
                    mimeType = mimeType,
                    data = Base64.encodeToString(bytes, Base64.NO_WRAP),
                    sizeBytes = bytes.size.toLong()
                )
            } catch (_: Exception) { null }
        }
        pendingAttachments = pendingAttachments + attachments
    }

    // Auto-scroll to bottom on new messages
    LaunchedEffect(messages.size, streamingText) {
        if (messages.isNotEmpty() || streamingText.isNotEmpty()) {
            // +1 for streaming text item if present
            val targetIndex = messages.size + (if (streamingText.isNotEmpty()) 1 else 0) - 1
            if (targetIndex >= 0) {
                listState.animateScrollToItem(targetIndex.coerceAtLeast(0))
            }
        }
    }

    if (showRenameDialog) {
        RenameDialog(
            currentName = channelName,
            onConfirm = { newName ->
                onRename(newName)
                showRenameDialog = false
            },
            onDismiss = { showRenameDialog = false }
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        channelName,
                        modifier = Modifier.clickable { showRenameDialog = true }
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = ClaudeSurface
                )
            )
        },
        bottomBar = {
            Column {
                // Permission bar
                if (pendingPermission != null) {
                    PermissionBar(
                        request = pendingPermission,
                        onResponse = onPermissionResponse
                    )
                }

                // Attachment preview
                if (pendingAttachments.isNotEmpty()) {
                    Surface(
                        color = ClaudeSurfaceVariant,
                        modifier = Modifier.fillMaxWidth()
                    ) {
                        Row(
                            modifier = Modifier.padding(horizontal = 12.dp, vertical = 4.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Text(
                                text = "${pendingAttachments.size} file(s) attached",
                                fontSize = 12.sp,
                                color = ClaudeOnSurface.copy(alpha = 0.7f),
                                modifier = Modifier.weight(1f)
                            )
                            TextButton(onClick = { pendingAttachments = emptyList() }) {
                                Text("Clear", fontSize = 12.sp)
                            }
                        }
                    }
                }

                // Text input with stop and attachment buttons
                MessageInput(
                    text = inputText,
                    onTextChange = { inputText = it },
                    isAgentRunning = isAgentRunning,
                    onSend = {
                        if (inputText.isNotBlank() || pendingAttachments.isNotEmpty()) {
                            if (pendingAttachments.isNotEmpty() && onSendWithAttachments != null) {
                                onSendWithAttachments(inputText, pendingAttachments)
                                pendingAttachments = emptyList()
                            } else {
                                onSendPrompt(inputText)
                            }
                            inputText = ""
                            coroutineScope.launch {
                                listState.animateScrollToItem(
                                    (messages.size).coerceAtLeast(0)
                                )
                            }
                        }
                    },
                    onInterrupt = onInterrupt,
                    onAttach = { filePickerLauncher.launch("*/*") }
                )
            }
        }
    ) { padding ->
        LazyColumn(
            state = listState,
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(ClaudeBackground),
            contentPadding = PaddingValues(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            items(messages, key = { "${it.kind}-${it.timestamp}" }) { message ->
                MessageCard(message)
            }

            // Show streaming text as an in-progress card
            if (streamingText.isNotEmpty()) {
                item(key = "streaming") {
                    StreamingTextCard(streamingText)
                }
            }
        }
    }
}

// --- Message Cards ---

@Composable
private fun MessageCard(message: AgentMessage) {
    when (message.kind) {
        "user_prompt" -> UserPromptCard(message)
        AgentEventKind.ASSISTANT_TEXT -> AssistantTextCard(message)
        AgentEventKind.TOOL_USE -> ToolUseCard(message)
        AgentEventKind.TOOL_RESULT -> ToolResultCard(message)
        AgentEventKind.THINKING -> ThinkingCard(message)
        AgentEventKind.PERMISSION_REQUEST -> PermissionRequestCard(message)
        AgentEventKind.PERMISSION_RESOLVED -> PermissionResolvedCard(message)
        AgentEventKind.RESULT -> ResultCard(message)
        AgentEventKind.SYSTEM -> SystemCard(message)
        AgentEventKind.SESSION_END -> SystemCard(message)
    }
}

@Composable
private fun UserPromptCard(message: AgentMessage) {
    val text = message.data["text"] as? String ?: ""
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.End
    ) {
        Surface(
            shape = RoundedCornerShape(16.dp, 4.dp, 16.dp, 16.dp),
            color = UserBubble,
            modifier = Modifier.widthIn(max = 300.dp)
        ) {
            SelectionContainer {
                Text(
                    text = text,
                    modifier = Modifier.padding(12.dp),
                    color = ClaudeOnBackground,
                    fontSize = 14.sp
                )
            }
        }
    }
}

@Composable
private fun AssistantTextCard(message: AgentMessage) {
    val text = message.data["text"] as? String ?: ""
    if (text.isBlank()) return
    Surface(
        shape = RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp),
        color = BotBubble,
        modifier = Modifier.fillMaxWidth()
    ) {
        SelectionContainer {
            Text(
                text = text,
                modifier = Modifier.padding(12.dp),
                color = ClaudeOnBackground,
                fontSize = 14.sp,
                lineHeight = 20.sp
            )
        }
    }
}

@Composable
private fun StreamingTextCard(text: String) {
    Surface(
        shape = RoundedCornerShape(4.dp, 16.dp, 16.dp, 16.dp),
        color = BotBubble,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(12.dp)) {
            SelectionContainer {
                Text(
                    text = text,
                    color = ClaudeOnBackground,
                    fontSize = 14.sp,
                    lineHeight = 20.sp
                )
            }
            Spacer(modifier = Modifier.height(4.dp))
            Text(
                text = "typing...",
                color = ClaudeOnSurface.copy(alpha = 0.4f),
                fontSize = 11.sp,
                fontStyle = FontStyle.Italic
            )
        }
    }
}

@Composable
private fun ToolUseCard(message: AgentMessage) {
    val toolName = message.data["toolName"] as? String ?: "Tool"
    @Suppress("UNCHECKED_CAST")
    val input = message.data["input"] as? Map<String, Any?> ?: emptyMap()
    var expanded by remember { mutableStateOf(false) }

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = ClaudeSurfaceVariant,
        modifier = Modifier.fillMaxWidth()
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { expanded = !expanded },
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "\uD83D\uDD27",  // wrench emoji
                    fontSize = 14.sp
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = toolName,
                    fontWeight = FontWeight.SemiBold,
                    color = ClaudeSecondary,
                    fontSize = 13.sp,
                    modifier = Modifier.weight(1f)
                )
                Icon(
                    if (expanded) Icons.Default.KeyboardArrowUp else Icons.Default.KeyboardArrowDown,
                    contentDescription = "Toggle",
                    tint = ClaudeOnSurface.copy(alpha = 0.5f),
                    modifier = Modifier.size(18.dp)
                )
            }

            // Show key input field inline (command for Bash, file_path for file tools)
            val inlineField = input["command"] ?: input["file_path"] ?: input["pattern"] ?: input["query"]
            if (inlineField != null) {
                Text(
                    text = inlineField.toString().take(200),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 11.sp,
                    color = ClaudeOnSurface.copy(alpha = 0.7f),
                    lineHeight = 15.sp,
                    maxLines = if (expanded) Int.MAX_VALUE else 2,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }

            AnimatedVisibility(visible = expanded) {
                Column(modifier = Modifier.padding(top = 6.dp)) {
                    input.forEach { (key, value) ->
                        if (key != "command" && key != "file_path" && key != "pattern" && key != "query") {
                            Text(
                                text = "$key: ${value?.toString()?.take(200) ?: "null"}",
                                fontFamily = FontFamily.Monospace,
                                fontSize = 11.sp,
                                color = ClaudeOnSurface.copy(alpha = 0.6f),
                                lineHeight = 14.sp
                            )
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun ToolResultCard(message: AgentMessage) {
    val isError = message.data["isError"] as? Boolean ?: false
    val isProgress = message.data["isProgress"] as? Boolean ?: false
    val toolName = message.data["toolName"] as? String
    var expanded by remember { mutableStateOf(false) }

    if (isProgress) {
        // Tool progress — just show elapsed time
        val elapsed = message.data["elapsedSeconds"] as? Number
        if (elapsed != null && toolName != null) {
            Text(
                text = "  $toolName running... ${elapsed.toInt()}s",
                color = ClaudeOnSurface.copy(alpha = 0.4f),
                fontSize = 11.sp,
                fontStyle = FontStyle.Italic,
                modifier = Modifier.padding(start = 8.dp, top = 2.dp, bottom = 2.dp)
            )
        }
        return
    }

    val content = message.data["content"]
    val contentText = when (content) {
        is String -> content
        is List<*> -> content.joinToString("\n") { it?.toString() ?: "" }
        else -> content?.toString()
    }

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = if (isError) DenyRed.copy(alpha = 0.1f) else StatusRunning.copy(alpha = 0.08f),
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
    ) {
        Column(modifier = Modifier.padding(8.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = if (isError) "✗" else "✓",
                    color = if (isError) DenyRed else StatusRunning,
                    fontWeight = FontWeight.Bold,
                    fontSize = 13.sp
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = if (isError) "Error" else "Result",
                    fontSize = 12.sp,
                    color = ClaudeOnSurface.copy(alpha = 0.7f)
                )
            }
            if (contentText != null && contentText.isNotBlank()) {
                AnimatedVisibility(visible = expanded) {
                    SelectionContainer {
                        Text(
                            text = contentText.take(1000),
                            fontFamily = FontFamily.Monospace,
                            fontSize = 11.sp,
                            color = ClaudeOnSurface.copy(alpha = 0.6f),
                            lineHeight = 14.sp,
                            modifier = Modifier.padding(top = 4.dp)
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun ThinkingCard(message: AgentMessage) {
    val thinking = message.data["thinking"] as? String ?: ""
    if (thinking.isBlank()) return
    var expanded by remember { mutableStateOf(false) }

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = SystemBubble.copy(alpha = 0.5f),
        modifier = Modifier
            .fillMaxWidth()
            .clickable { expanded = !expanded }
    ) {
        Column(modifier = Modifier.padding(10.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = "💭",
                    fontSize = 12.sp
                )
                Spacer(modifier = Modifier.width(6.dp))
                Text(
                    text = "Thinking",
                    fontStyle = FontStyle.Italic,
                    color = ClaudeOnSurface.copy(alpha = 0.5f),
                    fontSize = 12.sp
                )
            }
            AnimatedVisibility(visible = expanded) {
                SelectionContainer {
                    Text(
                        text = thinking.take(2000),
                        fontStyle = FontStyle.Italic,
                        color = ClaudeOnSurface.copy(alpha = 0.4f),
                        fontSize = 12.sp,
                        lineHeight = 16.sp,
                        modifier = Modifier.padding(top = 4.dp)
                    )
                }
            }
        }
    }
}

@Composable
private fun PermissionRequestCard(message: AgentMessage) {
    val toolName = message.data["toolName"] as? String ?: "unknown"
    Surface(
        shape = RoundedCornerShape(8.dp),
        color = PermissionPending.copy(alpha = 0.15f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier.padding(10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(text = "⚠️", fontSize = 14.sp)
            Spacer(modifier = Modifier.width(8.dp))
            Text(
                text = "Permission requested: $toolName",
                color = PermissionPending,
                fontWeight = FontWeight.Medium,
                fontSize = 13.sp
            )
        }
    }
}

@Composable
private fun PermissionResolvedCard(message: AgentMessage) {
    val behavior = message.data["behavior"] as? String ?: "unknown"
    val allowed = behavior == "allow"
    Text(
        text = if (allowed) "  ✓ Allowed" else "  ✗ Denied",
        color = if (allowed) StatusRunning.copy(alpha = 0.7f) else DenyRed.copy(alpha = 0.7f),
        fontSize = 11.sp,
        modifier = Modifier.padding(start = 8.dp, top = 2.dp, bottom = 2.dp)
    )
}

@Composable
private fun ResultCard(message: AgentMessage) {
    val costUsd = message.data["totalCostUsd"] as? Number
    val numTurns = message.data["numTurns"] as? Number
    val isError = message.data["isError"] as? Boolean ?: false

    Surface(
        shape = RoundedCornerShape(8.dp),
        color = ClaudeSurfaceVariant.copy(alpha = 0.5f),
        modifier = Modifier.fillMaxWidth()
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 10.dp, vertical = 6.dp)
                .fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween
        ) {
            val statusText = if (isError) "Turn failed" else "Turn complete"
            Text(
                text = statusText,
                fontSize = 11.sp,
                color = if (isError) DenyRed.copy(alpha = 0.7f) else ClaudeOnSurface.copy(alpha = 0.5f)
            )
            val details = buildList {
                if (numTurns != null) add("${numTurns.toInt()} turns")
                if (costUsd != null) add("$${String.format("%.4f", costUsd.toDouble())}")
            }.joinToString(" · ")
            if (details.isNotBlank()) {
                Text(
                    text = details,
                    fontSize = 11.sp,
                    color = ClaudeOnSurface.copy(alpha = 0.4f)
                )
            }
        }
    }
}

@Composable
private fun SystemCard(message: AgentMessage) {
    val text = when (message.kind) {
        AgentEventKind.SYSTEM -> {
            val model = message.data["model"] as? String
            val version = message.data["version"] as? String
            buildList {
                if (model != null) add("Model: $model")
                if (version != null) add("v$version")
            }.joinToString(" · ").ifEmpty { "Session initialized" }
        }
        AgentEventKind.SESSION_END -> {
            val reason = message.data["reason"] as? String
            val error = message.data["error"] as? String
            error ?: reason ?: "Session ended"
        }
        else -> return
    }

    Text(
        text = text,
        color = ClaudeOnSurface.copy(alpha = 0.4f),
        fontSize = 11.sp,
        fontStyle = FontStyle.Italic,
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        textAlign = androidx.compose.ui.text.style.TextAlign.Center
    )
}

// --- Permission Bar (bottom) ---

@Composable
private fun PermissionBar(
    request: PermissionRequest,
    onResponse: (requestId: String, behavior: String, answers: Map<String, String>?) -> Unit
) {
    Surface(
        color = PermissionPending.copy(alpha = 0.15f),
        tonalElevation = 2.dp
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 12.dp, vertical = 8.dp),
            verticalArrangement = Arrangement.spacedBy(6.dp)
        ) {
            if (request.questions != null && request.questions.isNotEmpty()) {
                // AskUserQuestion — show question with option buttons
                for (q in request.questions) {
                    Text(
                        text = q.question,
                        fontSize = 13.sp,
                        fontWeight = FontWeight.Medium,
                        color = ClaudeOnBackground
                    )
                    q.options.forEach { option ->
                        Button(
                            onClick = {
                                onResponse(
                                    request.requestId,
                                    "allow",
                                    mapOf(q.question to option.label)
                                )
                            },
                            modifier = Modifier.fillMaxWidth(),
                            colors = ButtonDefaults.buttonColors(containerColor = ApproveGreen),
                            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)
                        ) {
                            Column {
                                Text(
                                    text = option.label,
                                    fontWeight = FontWeight.Bold,
                                    fontSize = 13.sp
                                )
                                if (option.description.isNotBlank()) {
                                    Text(
                                        text = option.description,
                                        fontSize = 11.sp,
                                        color = ClaudeOnBackground.copy(alpha = 0.7f)
                                    )
                                }
                            }
                        }
                    }
                }
            } else {
                // Standard tool permission — Allow/Deny
                Text(
                    text = "Allow ${request.toolName}?",
                    fontSize = 13.sp,
                    fontWeight = FontWeight.Medium,
                    color = ClaudeOnBackground
                )

                // Show input summary if available
                val summary = request.input["command"] ?: request.input["file_path"] ?: request.input["pattern"]
                if (summary != null) {
                    Text(
                        text = summary.toString().take(150),
                        fontFamily = FontFamily.Monospace,
                        fontSize = 11.sp,
                        color = ClaudeOnSurface.copy(alpha = 0.6f),
                        maxLines = 3,
                        modifier = Modifier.padding(bottom = 4.dp)
                    )
                }

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Button(
                        onClick = { onResponse(request.requestId, "allow", null) },
                        modifier = Modifier.weight(1f),
                        colors = ButtonDefaults.buttonColors(containerColor = ApproveGreen),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)
                    ) {
                        Text("Allow", fontWeight = FontWeight.Bold)
                    }
                    OutlinedButton(
                        onClick = { onResponse(request.requestId, "deny", null) },
                        modifier = Modifier.weight(1f),
                        contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)
                    ) {
                        Text("Deny", color = DenyRed)
                    }
                }
            }
        }
    }
}

// --- Shared Composables ---

/** Dialog for renaming a session. */
@Composable
private fun RenameDialog(
    currentName: String,
    onConfirm: (String) -> Unit,
    onDismiss: () -> Unit
) {
    var text by remember { mutableStateOf(currentName) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Rename Session") },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                label = { Text("Session name") }
            )
        },
        confirmButton = {
            TextButton(
                onClick = { if (text.isNotBlank()) onConfirm(text.trim()) },
                enabled = text.isNotBlank()
            ) {
                Text("Rename")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

@Composable
private fun MessageInput(
    text: String,
    onTextChange: (String) -> Unit,
    isAgentRunning: Boolean = false,
    onSend: () -> Unit,
    onInterrupt: (() -> Unit)? = null,
    onAttach: (() -> Unit)? = null
) {
    Surface(
        color = ClaudeSurface,
        tonalElevation = 4.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp, vertical = 8.dp)
                .imePadding(),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Attachment button
            if (onAttach != null) {
                IconButton(
                    onClick = onAttach,
                    modifier = Modifier.size(40.dp)
                ) {
                    Icon(
                        Icons.Default.AttachFile,
                        contentDescription = "Attach file",
                        tint = ClaudeOnSurface.copy(alpha = 0.6f)
                    )
                }
            }

            OutlinedTextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Type a message...", color = ClaudeOnSurface.copy(alpha = 0.4f)) },
                maxLines = 4,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
                keyboardActions = KeyboardActions(onSend = { onSend() }),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ClaudePrimary,
                    cursorColor = ClaudePrimary
                ),
                shape = RoundedCornerShape(24.dp)
            )

            Spacer(modifier = Modifier.width(8.dp))

            if (isAgentRunning && onInterrupt != null) {
                // Stop button — visible when agent is running
                IconButton(
                    onClick = onInterrupt,
                    modifier = Modifier
                        .size(44.dp)
                        .background(DenyRed, CircleShape)
                ) {
                    Icon(
                        Icons.Default.Stop,
                        contentDescription = "Stop",
                        tint = Color.White
                    )
                }
            } else {
                // Send button
                IconButton(
                    onClick = onSend,
                    modifier = Modifier
                        .size(44.dp)
                        .background(
                            if (text.isNotBlank()) ClaudePrimary else ClaudeSurfaceVariant,
                            CircleShape
                        )
                ) {
                    Icon(
                        Icons.AutoMirrored.Filled.Send,
                        contentDescription = "Send",
                        tint = if (text.isNotBlank()) ClaudeOnBackground else ClaudeOnSurface.copy(alpha = 0.4f)
                    )
                }
            }
        }
    }
}
