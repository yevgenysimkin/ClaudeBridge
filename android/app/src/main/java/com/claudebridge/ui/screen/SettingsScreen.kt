package com.claudebridge.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.claudebridge.data.Preferences
import com.claudebridge.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onBack: () -> Unit,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    connected: Boolean
) {
    val context = LocalContext.current
    val prefs = remember { Preferences(context) }

    var relayUrl by remember { mutableStateOf(prefs.relayUrl) }
    var authToken by remember { mutableStateOf(prefs.authToken) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
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
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                "Relay Connection",
                style = MaterialTheme.typography.titleMedium,
                color = ClaudePrimary
            )

            OutlinedTextField(
                value = relayUrl,
                onValueChange = { relayUrl = it },
                label = { Text("Relay URL") },
                placeholder = { Text("https://your-relay.up.railway.app") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ClaudePrimary,
                    cursorColor = ClaudePrimary
                )
            )

            OutlinedTextField(
                value = authToken,
                onValueChange = { authToken = it },
                label = { Text("Auth Token") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                shape = RoundedCornerShape(12.dp),
                colors = OutlinedTextFieldDefaults.colors(
                    focusedBorderColor = ClaudePrimary,
                    cursorColor = ClaudePrimary
                )
            )

            Spacer(modifier = Modifier.height(8.dp))

            if (connected) {
                Button(
                    onClick = {
                        onDisconnect()
                    },
                    modifier = Modifier.fillMaxWidth(),
                    colors = ButtonDefaults.buttonColors(containerColor = DenyRed),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text("Disconnect")
                }
            } else {
                Button(
                    onClick = {
                        prefs.relayUrl = relayUrl.trim()
                        prefs.authToken = authToken.trim()
                        onConnect()
                    },
                    modifier = Modifier.fillMaxWidth(),
                    enabled = relayUrl.isNotBlank() && authToken.isNotBlank(),
                    colors = ButtonDefaults.buttonColors(containerColor = ApproveGreen),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text("Connect")
                }
            }
        }
    }
}
