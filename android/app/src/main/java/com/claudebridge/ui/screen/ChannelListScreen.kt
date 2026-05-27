package com.claudebridge.ui.screen

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudebridge.data.Channel
import com.claudebridge.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelListScreen(
    channels: List<Channel>,
    connected: Boolean,
    allowedRoot: String?,
    onRefresh: () -> Unit,
    onChannelClick: (String) -> Unit,
    onRemoveChannel: (String) -> Unit,
    onSettingsClick: () -> Unit,
    onNewSessionClick: () -> Unit
) {
    // Remote-start is available when the desktop has reported a non-empty
    // allowed root. null = haven't heard back yet (probe was sent but no reply
    // — disable until we know); "" = desktop explicitly says unconfigured.
    val canStart = !allowedRoot.isNullOrEmpty() && connected
    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text("ClaudeBridge")
                        Spacer(modifier = Modifier.width(8.dp))
                        StatusDot(connected)
                    }
                },
                actions = {
                    IconButton(onClick = onNewSessionClick, enabled = canStart) {
                        Icon(
                            Icons.Default.Add,
                            contentDescription = if (canStart) "Start new session"
                                                 else "Configure Android-allowed root in Chromattica settings"
                        )
                    }
                    IconButton(onClick = onRefresh) {
                        Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                    }
                    IconButton(onClick = onSettingsClick) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(
                    containerColor = ClaudeSurface
                )
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            if (channels.isEmpty()) {
                Box(
                    modifier = Modifier.fillMaxSize(),
                    contentAlignment = Alignment.Center
                ) {
                    Text(
                        if (connected) "No agents registered yet" else "Not connected",
                        color = ClaudeOnSurface.copy(alpha = 0.6f),
                        fontSize = 16.sp
                    )
                }
            } else {
                LazyColumn(modifier = Modifier.fillMaxSize()) {
                    items(channels, key = { it.id }) { channel ->
                        SwipeToDismissChannelRow(
                            channel = channel,
                            onClick = { onChannelClick(channel.id) },
                            onDismiss = { onRemoveChannel(channel.id) }
                        )
                    }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun SwipeToDismissChannelRow(
    channel: Channel,
    onClick: () -> Unit,
    onDismiss: () -> Unit
) {
    val dismissState = rememberSwipeToDismissBoxState(
        confirmValueChange = { value ->
            if (value == SwipeToDismissBoxValue.EndToStart) {
                onDismiss()
                true
            } else {
                false
            }
        }
    )

    SwipeToDismissBox(
        state = dismissState,
        enableDismissFromStartToEnd = false,
        backgroundContent = {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color(0xFFB33A3A))
                    .padding(horizontal = 20.dp),
                contentAlignment = Alignment.CenterEnd
            ) {
                Text("Remove", color = Color.White, fontWeight = FontWeight.Bold)
            }
        }
    ) {
        Box(modifier = Modifier.background(ClaudeBackground)) {
            ChannelRow(channel, onClick)
        }
    }
}

@Composable
private fun ChannelRow(channel: Channel, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 14.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(10.dp)
                .clip(CircleShape)
                .background(
                    when (channel.agentStatus) {
                        "running" -> StatusRunning
                        "idle" -> StatusIdle
                        else -> StatusStopped
                    }
                )
        )

        Spacer(modifier = Modifier.width(12.dp))

        Column(modifier = Modifier.weight(1f)) {
            Text(
                channel.name,
                fontWeight = FontWeight.Medium,
                fontSize = 16.sp,
                color = ClaudeOnBackground
            )
            Text(
                channel.agentStatus,
                fontSize = 13.sp,
                color = ClaudeOnSurface.copy(alpha = 0.6f)
            )
        }

        if (channel.pendingPermission) {
            Badge(
                containerColor = PermissionPending,
                contentColor = ClaudeBackground
            ) {
                Text("!", fontWeight = FontWeight.Bold)
            }
        }
    }

    HorizontalDivider(
        color = ClaudeSurfaceVariant,
        thickness = 0.5.dp,
        modifier = Modifier.padding(start = 38.dp)
    )
}

@Composable
private fun StatusDot(connected: Boolean) {
    Box(
        modifier = Modifier
            .size(8.dp)
            .clip(CircleShape)
            .background(if (connected) StatusRunning else StatusStopped)
    )
}
