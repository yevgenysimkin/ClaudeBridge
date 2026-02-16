package com.claudebridge.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudebridge.data.PermissionOption
import com.claudebridge.ui.theme.*
import kotlinx.coroutines.launch

// --- ANSI stripping ---

// Matches ANSI escape sequences (CSI, OSC, etc.)
private val ANSI_RE = Regex("\u001b\\[[0-9;]*[a-zA-Z]|\u001b\\][^\u0007]*\u0007|\u001b[()][AB012]|\u001b[=>]|\u001b\\[\\??[0-9;]*[hl]")

// Cursor-forward: \x1b[nC — replace with n spaces instead of stripping
private val CURSOR_FORWARD_RE = Regex("\u001b\\[(\\d*)C")

private fun stripAnsi(text: String): String {
    // First: replace cursor-forward with spaces (preserves word spacing)
    var result = text.replace(CURSOR_FORWARD_RE) { match ->
        val n = match.groupValues[1].toIntOrNull() ?: 1
        " ".repeat(n)
    }
    // Then strip remaining ANSI sequences
    result = result.replace(ANSI_RE, "")
    return result
}

// --- Phone display filter: WHITELIST approach ---

// Assistant text block: line starting with ⏺
private val ASSISTANT_LINE_RE = Regex("^\\s*⏺\\s*(.*)")

// User input line: line starting with ❯
private val USER_INPUT_RE = Regex("^\\s*❯\\s*(.*)")

// Tool call: content after ⏺ starts with a known tool name + (
private val TOOL_NAMES = setOf(
    "Bash", "Read", "Write", "Edit", "Glob", "Grep", "WebFetch", "WebSearch",
    "Task", "TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TaskStop", "TaskOutput",
    "NotebookEdit", "Skill", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
    "mcp__ide__getDiagnostics"
)
private val TOOL_CALL_RE = Regex("^\\s*(${TOOL_NAMES.joinToString("|")})\\s*\\(")

// Spinner line: starts with a spinner char (✻✶✳✢·✽ etc.) followed by Doing/Baked/Cooked
private val SPINNER_RE = Regex("^\\s*[✳✴✵✶✷✸✹✺✻✼✽✾✿✢·]\\s*(?:Doing|Baked|Cooked|Working|Running)")

// Max continuation lines to keep after an assistant ⏺ line
private const val MAX_CONTINUATION_LINES = 50

// Continuation line must start with a text character (letter, digit, or common punctuation)
// Includes em-dash, smart quotes, and other prose characters
private val REAL_TEXT_RE = Regex("^\\s*[a-zA-Z0-9\"'`(\\[{\\-—–\u2018\u2019\u201C\u201D*>#|!@%&/\\\\.,;:?~^+=]")

// Known TUI chrome phrases that look like text but aren't
private val TUI_CHROME_RE = Regex(
    "^\\s*(?:Press |ctrl\\+|shift\\+|esc to|accept edits|\\d+ files? [+-]|Brewed|Baked|Cooked|Nesting|Doing|Running|Working|Wait|timeout)",
    RegexOption.IGNORE_CASE
)

/** Result of extracting messages from raw buffer. */
data class ExtractResult(
    val messages: List<String>,
    val totalBullets: Int,
    val hasSpinner: Boolean
)

/**
 * Extract messages from raw PTY output.
 * Returns structured results: list of clean messages, total bullet count,
 * and whether a spinner is active (for thinking indicator).
 */
private fun extractMessages(raw: String): ExtractResult {
    val stripped = stripAnsi(raw)
    val lines = stripped.split("\n")
    val messages = mutableListOf<String>()
    val seen = LinkedHashSet<String>() // dedup across screen redraws
    var continuationCount = 0
    var inAssistantBlock = false
    var currentMessage = StringBuilder()
    var totalBullets = 0
    var hasSpinner = false

    fun flushMessage() {
        val msg = currentMessage.toString().trimEnd()
        if (msg.isNotBlank() && seen.add(msg)) {
            messages.add(msg)
        }
        currentMessage = StringBuilder()
        continuationCount = 0
    }

    for (line in lines) {
        // Check for assistant ⏺ line
        val bulletMatch = ASSISTANT_LINE_RE.find(line)
        if (bulletMatch != null) {
            val content = bulletMatch.groupValues[1]
            if (TOOL_CALL_RE.containsMatchIn(content)) {
                flushMessage()
                inAssistantBlock = false
                continue
            }
            totalBullets++
            if (content.isNotBlank()) {
                flushMessage()
                inAssistantBlock = true
                currentMessage.append(content)
            }
            continue
        }

        // Check for user input ❯ line
        val userMatch = USER_INPUT_RE.find(line)
        if (userMatch != null) {
            val input = userMatch.groupValues[1].trim()
            if (input.isNotBlank()) {
                flushMessage()
                inAssistantBlock = false
                val userMsg = "> $input"
                if (seen.add(userMsg)) messages.add(userMsg)
            }
            continue
        }

        // Check for spinner
        if (SPINNER_RE.containsMatchIn(line)) {
            hasSpinner = true
            inAssistantBlock = false
            continue
        }

        // Continuation of assistant block
        if (inAssistantBlock && continuationCount < MAX_CONTINUATION_LINES) {
            if (line.isBlank()) {
                continuationCount++
                currentMessage.append("\n")
                continue
            }
            if (REAL_TEXT_RE.containsMatchIn(line) && !TUI_CHROME_RE.containsMatchIn(line)) {
                continuationCount++
                currentMessage.append("\n").append(line)
                continue
            }
            inAssistantBlock = false
            continue
        }
    }
    flushMessage()

    return ExtractResult(messages, totalBullets, hasSpinner)
}

/** Public accessor: extract message list from raw buffer (for clear count). */
fun extractMessagesPublic(raw: String): List<String> = extractMessages(raw).messages

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TerminalScreen(
    channelName: String,
    channelId: String,
    buffer: String,
    displayBuffer: String,
    hasPermission: Boolean,
    permissionOptions: List<PermissionOption>,
    onBack: () -> Unit,
    onSend: (String) -> Unit,
    onApprove: () -> Unit,
    onDeny: () -> Unit,
    onSelectOption: (String) -> Unit,
    onClearBuffer: () -> Unit,
    onSendEsc: () -> Unit
) {
    var inputText by remember { mutableStateOf("") }
    val scrollState = rememberScrollState()
    val coroutineScope = rememberCoroutineScope()

    // Extract new messages from raw buffer and write to display buffer (once per message)
    LaunchedEffect(buffer) {
        val extracted = extractMessages(buffer)
        for (msg in extracted.messages) {
            com.claudebridge.data.BridgeState.appendIfNew(channelId, msg)
        }
        // Show thinking indicator (ephemeral — will be pushed out by real messages)
        if (extracted.hasSpinner) {
            com.claudebridge.data.BridgeState.appendIfNew(channelId, "thinking...")
        }
    }

    val cleanBuffer = displayBuffer

    // Auto-scroll to bottom when buffer changes
    LaunchedEffect(cleanBuffer) {
        scrollState.animateScrollTo(scrollState.maxValue)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(channelName) },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    // ESC button
                    IconButton(onClick = onSendEsc) {
                        Icon(
                            Icons.Filled.Close,
                            contentDescription = "Send ESC (interrupt)",
                            tint = DenyRed
                        )
                    }
                    // Trash button
                    IconButton(onClick = onClearBuffer) {
                        Icon(
                            Icons.Filled.Delete,
                            contentDescription = "Clear history",
                            tint = ClaudeOnSurface
                        )
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
                if (hasPermission) {
                    if (permissionOptions.isNotEmpty()) {
                        PermissionOptionsBar(
                            options = permissionOptions,
                            onSelectOption = onSelectOption
                        )
                    } else {
                        PermissionBinaryBar(
                            onApprove = onApprove,
                            onDeny = onDeny
                        )
                    }
                }

                // Text input
                TerminalInput(
                    text = inputText,
                    onTextChange = { inputText = it },
                    onSend = {
                        if (inputText.isNotBlank()) {
                            onSend(inputText)
                            inputText = ""
                            coroutineScope.launch {
                                scrollState.animateScrollTo(scrollState.maxValue)
                            }
                        }
                    }
                )
            }
        }
    ) { padding ->
        // Terminal output
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .background(Color(0xFF1A1A2E))
        ) {
            SelectionContainer {
                Text(
                    text = cleanBuffer.ifEmpty { "Waiting for output..." },
                    modifier = Modifier
                        .fillMaxSize()
                        .verticalScroll(scrollState)
                        .padding(12.dp),
                    fontFamily = FontFamily.Monospace,
                    fontSize = 13.sp,
                    lineHeight = 18.sp,
                    color = if (cleanBuffer.isEmpty()) Color(0xFF6B7280) else Color(0xFFE0E0E0)
                )
            }
        }
    }
}

/** Multi-option permission bar: one button per parsed option. */
@Composable
private fun PermissionOptionsBar(
    options: List<PermissionOption>,
    onSelectOption: (String) -> Unit
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
            Text(
                "Permission requested",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                color = ClaudeOnBackground
            )
            options.forEach { option ->
                val isDeny = option.label.lowercase().let { it.startsWith("no") || it.startsWith("deny") }
                if (isDeny) {
                    OutlinedButton(
                        onClick = { onSelectOption(option.number) },
                        modifier = Modifier.fillMaxWidth(),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)
                    ) {
                        Text(
                            "${option.number}. ${option.label}",
                            color = DenyRed,
                            fontSize = 13.sp
                        )
                    }
                } else {
                    Button(
                        onClick = { onSelectOption(option.number) },
                        modifier = Modifier.fillMaxWidth(),
                        colors = ButtonDefaults.buttonColors(containerColor = ApproveGreen),
                        contentPadding = PaddingValues(horizontal = 16.dp, vertical = 6.dp)
                    ) {
                        Text(
                            "${option.number}. ${option.label}",
                            fontWeight = FontWeight.Bold,
                            fontSize = 13.sp
                        )
                    }
                }
            }
        }
    }
}

/** Fallback binary Approve/Deny bar for simple [Y/n] prompts. */
@Composable
private fun PermissionBinaryBar(
    onApprove: () -> Unit,
    onDeny: () -> Unit
) {
    Surface(
        color = PermissionPending.copy(alpha = 0.15f),
        tonalElevation = 2.dp
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp, vertical = 10.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                "Permission requested",
                modifier = Modifier.weight(1f),
                fontSize = 14.sp,
                fontWeight = FontWeight.Medium,
                color = ClaudeOnBackground
            )
            Button(
                onClick = onApprove,
                colors = ButtonDefaults.buttonColors(containerColor = ApproveGreen),
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)
            ) {
                Text("Approve", fontWeight = FontWeight.Bold)
            }
            OutlinedButton(
                onClick = onDeny,
                contentPadding = PaddingValues(horizontal = 20.dp, vertical = 4.dp)
            ) {
                Text("Deny", color = DenyRed)
            }
        }
    }
}

@Composable
private fun TerminalInput(
    text: String,
    onTextChange: (String) -> Unit,
    onSend: () -> Unit
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
            OutlinedTextField(
                value = text,
                onValueChange = onTextChange,
                modifier = Modifier.weight(1f),
                placeholder = { Text("Type here...", color = ClaudeOnSurface.copy(alpha = 0.4f)) },
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
