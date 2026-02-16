package com.claudebridge

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalContext
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import com.claudebridge.data.Preferences
import com.claudebridge.ui.screen.ChannelListScreen
import com.claudebridge.ui.screen.TerminalScreen
import com.claudebridge.ui.screen.SettingsScreen
import com.claudebridge.ui.theme.ClaudeBridgeTheme
import com.claudebridge.ui.viewmodel.ChatViewModel

class MainActivity : ComponentActivity() {

    private val notificationPermissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { /* no-op */ }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        requestNotificationPermission()

        setContent {
            ClaudeBridgeTheme {
                ClaudeBridgeNavHost()
            }
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED
            ) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }
}

@Composable
fun ClaudeBridgeNavHost() {
    val navController = rememberNavController()
    val vm: ChatViewModel = viewModel()
    val context = LocalContext.current
    val prefs = remember { Preferences(context) }

    val connected by vm.connected.collectAsState()
    val channels by vm.channels.collectAsState()
    val buffers by vm.buffers.collectAsState()
    val displayBuffers by vm.displayBuffers.collectAsState()
    val activePermission by vm.activePermission.collectAsState()
    val permissionOptions by vm.permissionOptions.collectAsState()
    val currentChannel by vm.currentChannel.collectAsState()

    // Auto-connect on launch if configured
    LaunchedEffect(Unit) {
        if (prefs.isConfigured) {
            vm.startConnection()
        }
    }

    NavHost(navController = navController, startDestination = "channels") {
        composable("channels") {
            ChannelListScreen(
                channels = channels,
                connected = connected,
                onRefresh = { vm.refresh() },
                onChannelClick = { channelId ->
                    vm.selectChannel(channelId)
                    navController.navigate("terminal/$channelId")
                },
                onSettingsClick = {
                    navController.navigate("settings")
                }
            )
        }

        composable("terminal/{channelId}") { backStackEntry ->
            val channelId = backStackEntry.arguments?.getString("channelId") ?: return@composable
            val channel = channels.find { it.id == channelId }
            val buffer = buffers[channelId] ?: ""

            TerminalScreen(
                channelName = channel?.name ?: channelId,
                channelId = channelId,
                buffer = buffer,
                displayBuffer = displayBuffers[channelId] ?: "",
                hasPermission = activePermission == channelId,
                permissionOptions = if (activePermission == channelId) permissionOptions else emptyList(),
                onBack = {
                    vm.selectChannel(null)
                    navController.popBackStack()
                },
                onSend = { text -> vm.sendInput(text) },
                onApprove = { vm.sendRaw(channelId, "y\n") },
                onDeny = { vm.sendRaw(channelId, "n\n") },
                onSelectOption = { number -> vm.selectOption(channelId, number) },
                onClearBuffer = { vm.clearBuffer(channelId) },
                onSendEsc = { vm.sendEsc(channelId) }
            )
        }

        composable("settings") {
            SettingsScreen(
                onBack = { navController.popBackStack() },
                onConnect = { vm.startConnection() },
                onDisconnect = { vm.stopConnection() },
                connected = connected
            )
        }
    }
}
