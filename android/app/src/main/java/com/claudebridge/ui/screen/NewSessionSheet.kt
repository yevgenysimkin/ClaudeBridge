package com.claudebridge.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudebridge.data.DirectoryListing
import com.claudebridge.data.ModelManifest
import com.claudebridge.data.ModelManifestEntry
import com.claudebridge.data.Preferences
import com.claudebridge.ui.theme.*
import kotlinx.coroutines.delay

/**
 * Modal bottom sheet for provoking a remote ClaudeBridge session.
 *
 * Lets the user browse inside the desktop's Android-allowed root, pick a
 * project folder, pick a model, optionally enable --dangerously-skip-permissions,
 * and hit Start. On a successful remote_session_started reply, the caller
 * navigates straight into the new session's xterm view.
 */

private const val START_TIMEOUT_MS = 15_000L

private fun String.effortLabel(): String =
    replaceFirstChar { if (it.isLowerCase()) it.titlecase() else it.toString() }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NewSessionSheet(
    prefs: Preferences,
    allowedRoot: String,
    currentDirListing: DirectoryListing?,
    modelManifest: ModelManifest?,
    onBrowseTo: (path: String?) -> Unit,
    onRequestModels: () -> Unit,
    // Returns the requestId so the sheet can cancel it on timeout/dismiss
    // (so a late reply doesn't fire onSessionStarted after the user gave up).
    onStart: (
        projectDir: String,
        model: String,
        effort: String,
        skipPermissions: Boolean,
        onResolved: (channelId: String?, error: String?) -> Unit
    ) -> String,
    onCancelStart: (requestId: String) -> Unit,
    onSessionStarted: (channelId: String) -> Unit,
    onDismiss: () -> Unit
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)

    // Local UI state — survives recomposition but not process death (sheet is
    // ephemeral; if the user backgrounds the app and returns, fine to reset).
    var selectedModel by remember { mutableStateOf(prefs.lastModel) }
    var selectedEffort by remember { mutableStateOf(prefs.lastEffort) }
    var skipPerms by remember { mutableStateOf(prefs.skipPermsPreference) }
    var modelMenuOpen by remember { mutableStateOf(false) }
    var effortMenuOpen by remember { mutableStateOf(false) }
    var starting by remember { mutableStateOf(false) }
    var startError by remember { mutableStateOf<String?>(null) }
    var pendingRequestId by remember { mutableStateOf("") }

    // Models come from the desktop (it runs the CLI, so it's authoritative).
    // Until the manifest arrives, fall back to the last-used model as a single
    // entry so the sheet is usable immediately; the list swaps in on reply.
    val models: List<ModelManifestEntry> = modelManifest?.models?.takeIf { it.isNotEmpty() }
        ?: listOf(ModelManifestEntry(prefs.lastModel, prefs.lastModel, emptyList()))
    val effortLevels = models.firstOrNull { it.id == selectedModel }?.effortLevels ?: emptyList()

    // First open: list the allowed root and ask the desktop for its model catalog.
    LaunchedEffect(Unit) {
        onBrowseTo(null)
        onRequestModels()
    }

    // When the manifest (re)arrives, keep the selection valid: if the stored
    // model isn't offered, fall back to the desktop's default, then the newest.
    LaunchedEffect(modelManifest) {
        val ids = models.map { it.id }
        if (selectedModel !in ids) {
            selectedModel = modelManifest?.defaultModel?.takeIf { it in ids }
                ?: ids.firstOrNull().orEmpty()
        }
    }

    // Keep effort valid for the selected model: if the model supports effort but
    // the current pick isn't one of its levels, default to the first level.
    LaunchedEffect(selectedModel, modelManifest) {
        selectedEffort = when {
            effortLevels.isEmpty() -> ""
            selectedEffort in effortLevels -> selectedEffort
            else -> effortLevels.first()
        }
    }

    // Timeout: if the desktop doesn't reply within START_TIMEOUT_MS, give the
    // user back control instead of leaving them staring at a "Starting…"
    // spinner that intercepts every tap on the channel list behind the sheet.
    // Most likely cause is a phone WS drop that lost the reply in transit.
    LaunchedEffect(starting) {
        if (!starting) return@LaunchedEffect
        delay(START_TIMEOUT_MS)
        if (starting) {
            onCancelStart(pendingRequestId)
            pendingRequestId = ""
            starting = false
            startError = "Desktop didn't reply within ${START_TIMEOUT_MS / 1000}s. " +
                "Make sure Chromattica is running and connected, then try again."
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp)
                .padding(bottom = 16.dp)
        ) {
            Text(
                "Start new session",
                fontSize = 18.sp,
                fontWeight = FontWeight.SemiBold,
                color = ClaudeOnBackground,
                modifier = Modifier.padding(vertical = 8.dp)
            )

            // --- Breadcrumb -------------------------------------------------
            PathBreadcrumb(
                currentPath = currentDirListing?.path,
                allowedRoot = allowedRoot,
                onSegmentClick = { absolute -> onBrowseTo(absolute) }
            )

            HorizontalDivider(
                color = ClaudeSurfaceVariant,
                thickness = 0.5.dp,
                modifier = Modifier.padding(vertical = 8.dp)
            )

            // --- Directory listing -----------------------------------------
            val listing = currentDirListing
            when {
                listing == null -> {
                    Box(
                        modifier = Modifier.fillMaxWidth().height(140.dp),
                        contentAlignment = Alignment.Center
                    ) { CircularProgressIndicator() }
                }

                !listing.error.isNullOrEmpty() -> {
                    Text(
                        listing.error,
                        color = StatusStopped,
                        fontSize = 14.sp,
                        modifier = Modifier.padding(vertical = 12.dp)
                    )
                }

                else -> {
                    val dirs = listing.entries.filter { it.isDir }
                    if (dirs.isEmpty()) {
                        Text(
                            "No subfolders here. Use \"Open here\" to start a session in the current folder.",
                            color = ClaudeOnSurface.copy(alpha = 0.6f),
                            fontSize = 13.sp,
                            modifier = Modifier.padding(vertical = 12.dp)
                        )
                    } else {
                        LazyColumn(
                            modifier = Modifier
                                .fillMaxWidth()
                                .heightIn(min = 80.dp, max = 280.dp)
                        ) {
                            items(dirs, key = { it.name }) { entry ->
                                Row(
                                    modifier = Modifier
                                        .fillMaxWidth()
                                        .clickable {
                                            onBrowseTo("${listing.path}/${entry.name}")
                                        }
                                        .padding(vertical = 12.dp),
                                    verticalAlignment = Alignment.CenterVertically
                                ) {
                                    Icon(
                                        Icons.Default.Folder,
                                        contentDescription = null,
                                        tint = ClaudeOnSurface.copy(alpha = 0.7f)
                                    )
                                    Spacer(Modifier.width(12.dp))
                                    Text(
                                        entry.name,
                                        color = ClaudeOnBackground,
                                        fontSize = 15.sp
                                    )
                                }
                            }
                        }
                    }
                }
            }

            HorizontalDivider(
                color = ClaudeSurfaceVariant,
                thickness = 0.5.dp,
                modifier = Modifier.padding(vertical = 8.dp)
            )

            // --- Model + effort --------------------------------------------
            Row(
                modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text("Model:", color = ClaudeOnBackground, fontSize = 14.sp)
                Spacer(Modifier.width(12.dp))
                Box {
                    OutlinedButton(onClick = { modelMenuOpen = true }) {
                        Text(models.firstOrNull { it.id == selectedModel }?.label
                             ?: selectedModel)
                        Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                    }
                    DropdownMenu(
                        expanded = modelMenuOpen,
                        onDismissRequest = { modelMenuOpen = false }
                    ) {
                        models.forEach { opt ->
                            DropdownMenuItem(
                                text = { Text(opt.label) },
                                onClick = {
                                    selectedModel = opt.id
                                    modelMenuOpen = false
                                }
                            )
                        }
                    }
                }

                // Effort selector — only for models that support variable effort.
                if (effortLevels.isNotEmpty()) {
                    Spacer(Modifier.width(12.dp))
                    Text("Effort:", color = ClaudeOnBackground, fontSize = 14.sp)
                    Spacer(Modifier.width(8.dp))
                    Box {
                        OutlinedButton(onClick = { effortMenuOpen = true }) {
                            Text(selectedEffort.ifEmpty { effortLevels.first() }.effortLabel())
                            Icon(Icons.Default.ArrowDropDown, contentDescription = null)
                        }
                        DropdownMenu(
                            expanded = effortMenuOpen,
                            onDismissRequest = { effortMenuOpen = false }
                        ) {
                            effortLevels.forEach { level ->
                                DropdownMenuItem(
                                    text = { Text(level.effortLabel()) },
                                    onClick = {
                                        selectedEffort = level
                                        effortMenuOpen = false
                                    }
                                )
                            }
                        }
                    }
                }
            }

            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { skipPerms = !skipPerms }
                    .padding(vertical = 4.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Checkbox(checked = skipPerms, onCheckedChange = { skipPerms = it })
                Spacer(Modifier.width(4.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text("Skip permissions",
                         color = ClaudeOnBackground, fontSize = 14.sp)
                    Text("Pass --dangerously-skip-permissions to claude",
                         color = ClaudeOnSurface.copy(alpha = 0.55f), fontSize = 11.sp)
                }
            }

            // --- Start error (if any) --------------------------------------
            startError?.let {
                Text(
                    it,
                    color = StatusStopped,
                    fontSize = 13.sp,
                    modifier = Modifier.padding(vertical = 8.dp)
                )
            }

            // --- Start button ----------------------------------------------
            Button(
                modifier = Modifier.fillMaxWidth().padding(top = 12.dp),
                enabled = !starting && !currentDirListing?.path.isNullOrEmpty()
                          && currentDirListing?.error.isNullOrEmpty(),
                onClick = {
                    val path = currentDirListing?.path ?: return@Button
                    starting = true
                    startError = null
                    // Persist choices so the next open of the sheet defaults to them.
                    val effortToSend = if (effortLevels.isEmpty()) "" else selectedEffort
                    prefs.lastModel = selectedModel
                    prefs.lastEffort = effortToSend
                    prefs.skipPermsPreference = skipPerms
                    pendingRequestId = onStart(path, selectedModel, effortToSend, skipPerms) { channelId, error ->
                        pendingRequestId = ""
                        starting = false
                        if (channelId != null) {
                            onSessionStarted(channelId)
                        } else {
                            startError = error ?: "Unknown error starting session"
                        }
                    }
                }
            ) {
                if (starting) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(18.dp),
                        strokeWidth = 2.dp,
                        color = ClaudeBackground
                    )
                    Spacer(Modifier.width(8.dp))
                    Text("Starting…")
                } else {
                    val label = currentDirListing?.path?.substringAfterLast('/') ?: "…"
                    Text("Start session in “$label”")
                }
            }
        }
    }
}

/** Clickable breadcrumb. The allowedRoot is always the first segment and is
 *  rendered as "<root-name>"; segments past it are tappable to navigate back. */
@Composable
private fun PathBreadcrumb(
    currentPath: String?,
    allowedRoot: String,
    onSegmentClick: (absolute: String) -> Unit
) {
    if (currentPath.isNullOrEmpty() || allowedRoot.isEmpty()) {
        Text(
            "Loading…",
            color = ClaudeOnSurface.copy(alpha = 0.6f),
            fontSize = 13.sp
        )
        return
    }

    // Compute segments relative to the allowed root so the user only ever
    // navigates within their own permitted area.
    val relative = if (currentPath == allowedRoot) "" else
        currentPath.removePrefix("$allowedRoot/")
    val parts = if (relative.isEmpty()) emptyList() else relative.split('/')

    val rootLabel = allowedRoot.substringAfterLast('/').ifEmpty { allowedRoot }

    Row(
        modifier = Modifier.fillMaxWidth(),
        verticalAlignment = Alignment.CenterVertically
    ) {
        BreadcrumbChip(text = rootLabel) { onSegmentClick(allowedRoot) }
        var accumulator = allowedRoot
        parts.forEach { segment ->
            accumulator = "$accumulator/$segment"
            Text(" › ", color = ClaudeOnSurface.copy(alpha = 0.5f))
            val absolute = accumulator
            BreadcrumbChip(text = segment) { onSegmentClick(absolute) }
        }
    }
}

@Composable
private fun BreadcrumbChip(text: String, onClick: () -> Unit) {
    Text(
        text,
        color = ClaudeSecondary,
        fontSize = 13.sp,
        fontWeight = FontWeight.Medium,
        modifier = Modifier
            .background(ClaudeSurfaceVariant.copy(alpha = 0.4f))
            .clickable(onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp)
    )
}
