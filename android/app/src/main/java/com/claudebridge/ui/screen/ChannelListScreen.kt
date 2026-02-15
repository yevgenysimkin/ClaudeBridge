package com.claudebridge.ui.screen

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudebridge.data.Channel
import com.claudebridge.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelListScreen(
    channels: List<Channel>,
    connected: Boolean,
    mode: String,
    onModeToggle: () -> Unit,
    onChannelClick: (String) -> Unit,
    onSettingsClick: () -> Unit
) {
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
            // --- Mode Toggle ---
            if (connected) {
                ModeToggle(
                    isPhoneMode = mode == "phone",
                    onToggle = onModeToggle
                )
            }

            // --- Channel List ---
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
                        ChannelRow(channel, onClick = { onChannelClick(channel.id) })
                    }
                }
            }
        }
    }
}

@Composable
private fun ModeToggle(isPhoneMode: Boolean, onToggle: () -> Unit) {
    val backgroundColor by animateColorAsState(
        targetValue = if (isPhoneMode) ModePhone.copy(alpha = 0.15f) else ClaudeSurfaceVariant,
        label = "modeBg"
    )
    val accentColor by animateColorAsState(
        targetValue = if (isPhoneMode) ModePhone else ModeDesktop,
        label = "modeAccent"
    )

    Surface(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        shape = RoundedCornerShape(16.dp),
        color = backgroundColor,
        onClick = onToggle
    ) {
        Row(
            modifier = Modifier
                .padding(horizontal = 20.dp, vertical = 16.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Box(
                modifier = Modifier
                    .size(12.dp)
                    .clip(CircleShape)
                    .background(accentColor)
            )
            Spacer(modifier = Modifier.width(12.dp))
            Text(
                text = if (isPhoneMode) "PHONE" else "DESKTOP",
                fontSize = 20.sp,
                fontWeight = FontWeight.Bold,
                color = accentColor,
                textAlign = TextAlign.Center
            )
            Spacer(modifier = Modifier.width(12.dp))
            Text(
                text = if (isPhoneMode) "Permissions route to phone" else "Permissions at terminal",
                fontSize = 13.sp,
                color = ClaudeOnSurface.copy(alpha = 0.7f)
            )
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
        // Agent status indicator
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
        } else if (channel.unread > 0) {
            Badge(
                containerColor = ClaudePrimary,
                contentColor = ClaudeBackground
            ) {
                Text("${channel.unread}")
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
