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
import com.claudebridge.data.ChromatticaApi
import com.claudebridge.data.ConfigRefreshResult
import com.claudebridge.data.Preferences
import com.claudebridge.ui.screen.ChannelListScreen
import com.claudebridge.ui.screen.WebViewSessionScreen
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
    val messages by vm.messages.collectAsState()
    val pendingPermission by vm.pendingPermission.collectAsState()
    val streamingText by vm.streamingText.collectAsState()
    val currentChannel by vm.currentChannel.collectAsState()

    // Refresh config from server on launch, then auto-connect
    LaunchedEffect(Unit) {
        if (prefs.isLoggedIn) {
            when (val result = ChromatticaApi.refreshConfig(prefs.sessionToken)) {
                is ConfigRefreshResult.Success -> {
                    prefs.relayUrl = result.relayUrl
                    prefs.authToken = result.relayAuthToken
                }
                is ConfigRefreshResult.SessionExpired -> {
                    prefs.clear()  // Force re-login
                }
                else -> { /* Error — keep existing values */ }
            }
        }
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
                    navController.navigate("session/$channelId")
                },
                onRemoveChannel = { channelId -> vm.removeChannel(channelId) },
                onSettingsClick = {
                    navController.navigate("settings")
                }
            )
        }

        composable("session/{channelId}") { backStackEntry ->
            val channelId = backStackEntry.arguments?.getString("channelId") ?: return@composable
            val channel = channels.find { it.id == channelId }

            WebViewSessionScreen(
                relayUrl = prefs.relayUrl,
                authToken = prefs.authToken,
                channelId = channelId,
                channelName = channel?.name ?: channelId,
                onBack = {
                    vm.selectChannel(null)
                    navController.popBackStack()
                }
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
