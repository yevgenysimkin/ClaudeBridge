package com.claudebridge.ui.screen

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.claudebridge.data.ChromatticaApi
import com.claudebridge.data.ConfigRefreshResult
import com.claudebridge.data.OtpRequestResult
import com.claudebridge.data.OtpVerifyResult
import com.claudebridge.data.Preferences
import com.claudebridge.ui.theme.*
import kotlinx.coroutines.launch

private const val OTP_CODE_LENGTH = 6

/** Severity level for refresh status feedback. */
enum class RefreshLevel { SUCCESS, WARNING, ERROR }

/** Inline status card state after a config refresh. */
data class RefreshStatus(val level: RefreshLevel, val message: String)

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
    val scope = rememberCoroutineScope()

    // Login state
    var page by remember { mutableStateOf(if (prefs.isLoggedIn) "account" else "email") }
    var email by remember { mutableStateOf(prefs.email.ifBlank { "" }) }
    var otpCode by remember { mutableStateOf("") }
    var statusMessage by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }
    var isError by remember { mutableStateOf(false) }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = ClaudeSurface)
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 24.dp, vertical = 16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            when (page) {
                "email" -> EmailPage(
                    email = email,
                    onEmailChange = { email = it },
                    statusMessage = statusMessage,
                    isError = isError,
                    isLoading = isLoading,
                    onSubmit = {
                        scope.launch {
                            isLoading = true
                            statusMessage = ""
                            isError = false
                            when (val result = ChromatticaApi.requestOtp(email.trim())) {
                                is OtpRequestResult.Success -> {
                                    page = "otp"
                                    statusMessage = ""
                                }
                                is OtpRequestResult.RateLimited -> {
                                    statusMessage = "Please wait ${result.retryAfterSeconds}s before requesting another code"
                                    isError = true
                                }
                                is OtpRequestResult.Error -> {
                                    statusMessage = result.message
                                    isError = true
                                }
                            }
                            isLoading = false
                        }
                    }
                )

                "otp" -> OtpPage(
                    email = email,
                    otpCode = otpCode,
                    onCodeChange = { if (it.length <= OTP_CODE_LENGTH) otpCode = it },
                    statusMessage = statusMessage,
                    isError = isError,
                    isLoading = isLoading,
                    onVerify = {
                        scope.launch {
                            isLoading = true
                            statusMessage = ""
                            isError = false
                            when (val result = ChromatticaApi.verifyOtp(email.trim(), otpCode.trim())) {
                                is OtpVerifyResult.Success -> {
                                    prefs.sessionToken = result.sessionToken
                                    prefs.email = result.email
                                    if (result.relayUrl.isNotBlank()) {
                                        prefs.relayUrl = result.relayUrl
                                    }
                                    if (result.relayAuthToken.isNotBlank()) {
                                        prefs.authToken = result.relayAuthToken
                                    }
                                    page = "account"
                                    statusMessage = ""
                                    if (prefs.isConfigured) {
                                        onConnect()
                                    }
                                }
                                is OtpVerifyResult.InvalidCode -> {
                                    statusMessage = "Incorrect code (${result.attemptsRemaining} attempts remaining)"
                                    isError = true
                                    otpCode = ""
                                }
                                is OtpVerifyResult.Expired -> {
                                    statusMessage = "Code expired. Please request a new one."
                                    isError = true
                                    otpCode = ""
                                    page = "email"
                                }
                                is OtpVerifyResult.Error -> {
                                    statusMessage = result.message
                                    isError = true
                                }
                            }
                            isLoading = false
                        }
                    },
                    onBack = {
                        page = "email"
                        otpCode = ""
                        statusMessage = ""
                        isError = false
                    },
                    onResend = {
                        scope.launch {
                            isLoading = true
                            otpCode = ""
                            statusMessage = ""
                            isError = false
                            when (val result = ChromatticaApi.requestOtp(email.trim())) {
                                is OtpRequestResult.Success -> {
                                    statusMessage = "New code sent"
                                    isError = false
                                }
                                is OtpRequestResult.RateLimited -> {
                                    statusMessage = "Please wait ${result.retryAfterSeconds}s"
                                    isError = true
                                }
                                is OtpRequestResult.Error -> {
                                    statusMessage = result.message
                                    isError = true
                                }
                            }
                            isLoading = false
                        }
                    }
                )

                "account" -> {
                    // Track relay state so refresh updates the UI
                    var currentRelayUrl by remember { mutableStateOf(prefs.relayUrl) }
                    var currentIsConfigured by remember { mutableStateOf(prefs.isConfigured) }
                    var hasAuthToken by remember { mutableStateOf(prefs.authToken.isNotBlank()) }
                    var refreshStatus by remember { mutableStateOf<RefreshStatus?>(null) }

                    AccountPage(
                        email = prefs.email,
                        relayUrl = currentRelayUrl,
                        connected = connected,
                        isConfigured = currentIsConfigured,
                        hasAuthToken = hasAuthToken,
                        refreshStatus = refreshStatus,
                        onConnect = onConnect,
                        onDisconnect = onDisconnect,
                        onRefresh = {
                            scope.launch {
                                isLoading = true
                                refreshStatus = null
                                when (val result = ChromatticaApi.refreshConfig(
                                    prefs.sessionToken,
                                    prefs.authToken
                                )) {
                                    is ConfigRefreshResult.Success -> {
                                        prefs.relayUrl = result.relayUrl
                                        prefs.authToken = result.relayAuthToken
                                        currentRelayUrl = result.relayUrl
                                        currentIsConfigured = prefs.isConfigured
                                        hasAuthToken = result.relayAuthToken.isNotBlank()

                                        val tokenNote = if (result.tokenChanged)
                                            "\nAuth token updated (was out of sync with server)" else ""

                                        refreshStatus = when {
                                            result.serverHadRelayUrl && result.serverHadAuthToken ->
                                                RefreshStatus(
                                                    RefreshLevel.SUCCESS,
                                                    "Config synced — relay URL: ${result.relayUrl}$tokenNote"
                                                )
                                            result.serverHadAuthToken ->
                                                RefreshStatus(
                                                    RefreshLevel.WARNING,
                                                    "Server has auth token but no relay URL — open ClaudeBridge settings in Chromattica$tokenNote"
                                                )
                                            else ->
                                                RefreshStatus(
                                                    RefreshLevel.WARNING,
                                                    "Server has no ClaudeBridge config — configure relay URL in Chromattica first"
                                                )
                                        }
                                        if (prefs.isConfigured && !connected) onConnect()
                                    }
                                    is ConfigRefreshResult.SessionExpired -> {
                                        refreshStatus = RefreshStatus(
                                            RefreshLevel.ERROR,
                                            "Session expired — please sign in again"
                                        )
                                        ChromatticaApi.reportEvent(
                                            "config_refresh_failed",
                                            mapOf("httpStatus" to 401, "error" to "session_expired"),
                                            prefs.email
                                        )
                                        prefs.clear()
                                        page = "email"
                                        email = ""
                                    }
                                    is ConfigRefreshResult.Error -> {
                                        refreshStatus = RefreshStatus(
                                            RefreshLevel.ERROR,
                                            "Sync error: ${result.message}"
                                        )
                                        ChromatticaApi.reportEvent(
                                            "config_refresh_failed",
                                            mapOf("error" to result.message),
                                            prefs.email
                                        )
                                    }
                                    is ConfigRefreshResult.NetworkError -> {
                                        refreshStatus = RefreshStatus(
                                            RefreshLevel.ERROR,
                                            "Network error: Unable to reach api.chromattica.com"
                                        )
                                        ChromatticaApi.reportEvent(
                                            "config_refresh_failed",
                                            mapOf("error" to result.message, "network" to true)
                                        )
                                    }
                                }
                                isLoading = false
                            }
                        },
                        isRefreshing = isLoading,
                        onLogout = {
                            onDisconnect()
                            prefs.clear()
                            page = "email"
                            email = ""
                            otpCode = ""
                            statusMessage = ""
                            isError = false
                        }
                    )
                }
            }
        }
    }
}

@Composable
private fun EmailPage(
    email: String,
    onEmailChange: (String) -> Unit,
    statusMessage: String,
    isError: Boolean,
    isLoading: Boolean,
    onSubmit: () -> Unit
) {
    val emailValid = email.trim().matches(Regex("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"))

    Text(
        "Sign in with Chromattica",
        style = MaterialTheme.typography.titleLarge,
        color = ClaudePrimary
    )

    Text(
        "Enter your email to receive a verification code.",
        style = MaterialTheme.typography.bodyMedium,
        color = ClaudeOnSurface
    )

    Spacer(modifier = Modifier.height(8.dp))

    OutlinedTextField(
        value = email,
        onValueChange = onEmailChange,
        label = { Text("Email") },
        placeholder = { Text("you@example.com") },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Email,
            imeAction = ImeAction.Go
        ),
        keyboardActions = KeyboardActions(onGo = { if (emailValid && !isLoading) onSubmit() }),
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = ClaudePrimary,
            cursorColor = ClaudePrimary
        )
    )

    if (statusMessage.isNotBlank()) {
        Text(
            statusMessage,
            color = if (isError) DenyRed else ApproveGreen,
            style = MaterialTheme.typography.bodySmall
        )
    }

    Spacer(modifier = Modifier.height(8.dp))

    Button(
        onClick = onSubmit,
        modifier = Modifier.fillMaxWidth(),
        enabled = emailValid && !isLoading,
        colors = ButtonDefaults.buttonColors(containerColor = ClaudePrimary),
        shape = RoundedCornerShape(12.dp)
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = ClaudeOnBackground,
                strokeWidth = 2.dp
            )
        } else {
            Text("Continue")
        }
    }
}

@Composable
private fun OtpPage(
    email: String,
    otpCode: String,
    onCodeChange: (String) -> Unit,
    statusMessage: String,
    isError: Boolean,
    isLoading: Boolean,
    onVerify: () -> Unit,
    onBack: () -> Unit,
    onResend: () -> Unit
) {
    Text(
        "Enter verification code",
        style = MaterialTheme.typography.titleLarge,
        color = ClaudePrimary
    )

    Text(
        "A 6-digit code was sent to $email",
        style = MaterialTheme.typography.bodyMedium,
        color = ClaudeOnSurface
    )

    Spacer(modifier = Modifier.height(16.dp))

    OutlinedTextField(
        value = otpCode,
        onValueChange = { if (it.all { c -> c.isDigit() }) onCodeChange(it) },
        modifier = Modifier.fillMaxWidth(),
        singleLine = true,
        textStyle = LocalTextStyle.current.copy(
            textAlign = TextAlign.Center,
            fontSize = 28.sp,
            letterSpacing = 12.sp,
            fontFamily = FontFamily.Monospace
        ),
        keyboardOptions = KeyboardOptions(
            keyboardType = KeyboardType.Number,
            imeAction = ImeAction.Go
        ),
        keyboardActions = KeyboardActions(
            onGo = { if (otpCode.length == OTP_CODE_LENGTH && !isLoading) onVerify() }
        ),
        shape = RoundedCornerShape(12.dp),
        colors = OutlinedTextFieldDefaults.colors(
            focusedBorderColor = ClaudePrimary,
            cursorColor = ClaudePrimary
        )
    )

    if (statusMessage.isNotBlank()) {
        Text(
            statusMessage,
            color = if (isError) DenyRed else ApproveGreen,
            style = MaterialTheme.typography.bodySmall
        )
    }

    Spacer(modifier = Modifier.height(8.dp))

    Button(
        onClick = onVerify,
        modifier = Modifier.fillMaxWidth(),
        enabled = otpCode.length == OTP_CODE_LENGTH && !isLoading,
        colors = ButtonDefaults.buttonColors(containerColor = ClaudePrimary),
        shape = RoundedCornerShape(12.dp)
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = ClaudeOnBackground,
                strokeWidth = 2.dp
            )
        } else {
            Text("Verify")
        }
    }

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween
    ) {
        TextButton(onClick = onBack) {
            Text("Back", color = ClaudeOnSurface)
        }
        TextButton(onClick = onResend, enabled = !isLoading) {
            Text("Resend code", color = ClaudePrimary)
        }
    }
}

@Composable
private fun AccountPage(
    email: String,
    relayUrl: String,
    connected: Boolean,
    isConfigured: Boolean,
    hasAuthToken: Boolean,
    refreshStatus: RefreshStatus?,
    onConnect: () -> Unit,
    onDisconnect: () -> Unit,
    onRefresh: () -> Unit,
    isRefreshing: Boolean,
    onLogout: () -> Unit
) {
    Text(
        "Account",
        style = MaterialTheme.typography.titleLarge,
        color = ClaudePrimary
    )

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = ClaudeSurfaceVariant),
        shape = RoundedCornerShape(12.dp)
    ) {
        Column(modifier = Modifier.padding(16.dp)) {
            Text("Signed in as", style = MaterialTheme.typography.labelSmall, color = ClaudeOnSurface)
            Text(email, style = MaterialTheme.typography.bodyLarge, color = ClaudeOnBackground)
        }
    }

    if (isConfigured) {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = ClaudeSurfaceVariant),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                Text("Relay", style = MaterialTheme.typography.labelSmall, color = ClaudeOnSurface)
                Text(
                    relayUrl,
                    style = MaterialTheme.typography.bodyMedium,
                    color = ClaudeOnBackground
                )
                Spacer(modifier = Modifier.height(4.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Box(
                        modifier = Modifier.size(8.dp),
                        content = {
                            androidx.compose.foundation.Canvas(modifier = Modifier.fillMaxSize()) {
                                drawCircle(
                                    color = if (connected) StatusRunning else StatusStopped
                                )
                            }
                        }
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        if (connected) "Connected" else "Disconnected",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (connected) StatusRunning else StatusStopped
                    )
                }
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        if (connected) {
            Button(
                onClick = onDisconnect,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = DenyRed),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Disconnect")
            }
        } else {
            Button(
                onClick = onConnect,
                modifier = Modifier.fillMaxWidth(),
                colors = ButtonDefaults.buttonColors(containerColor = ApproveGreen),
                shape = RoundedCornerShape(12.dp)
            ) {
                Text("Connect")
            }
        }
    } else {
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = ClaudeSurfaceVariant),
            shape = RoundedCornerShape(12.dp)
        ) {
            Column(modifier = Modifier.padding(16.dp)) {
                if (hasAuthToken) {
                    Text(
                        "Auth token synced",
                        style = MaterialTheme.typography.bodyMedium,
                        color = ApproveGreen
                    )
                    Text(
                        "Waiting for relay URL — configure it in Chromattica on your desktop.",
                        style = MaterialTheme.typography.bodySmall,
                        color = ClaudeOnSurface
                    )
                } else {
                    Text(
                        "No relay configured",
                        style = MaterialTheme.typography.bodyMedium,
                        color = ClaudeOnSurface
                    )
                    Text(
                        "Set up ClaudeBridge in Chromattica on your desktop to configure your relay.",
                        style = MaterialTheme.typography.bodySmall,
                        color = ClaudeOnSurface
                    )
                }
            }
        }
    }

    Spacer(modifier = Modifier.height(16.dp))

    OutlinedButton(
        onClick = onRefresh,
        modifier = Modifier.fillMaxWidth(),
        enabled = !isRefreshing,
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = ClaudePrimary)
    ) {
        if (isRefreshing) {
            CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                color = ClaudePrimary,
                strokeWidth = 2.dp
            )
        } else {
            Text("Refresh config")
        }
    }

    // Inline status card — replaces Toasts
    if (refreshStatus != null) {
        val (bgColor, textColor) = when (refreshStatus.level) {
            RefreshLevel.SUCCESS -> Pair(ApproveGreen.copy(alpha = 0.15f), ApproveGreen)
            RefreshLevel.WARNING -> Pair(PermissionPending.copy(alpha = 0.15f), PermissionPending)
            RefreshLevel.ERROR -> Pair(DenyRed.copy(alpha = 0.15f), DenyRed)
        }
        Card(
            modifier = Modifier.fillMaxWidth(),
            colors = CardDefaults.cardColors(containerColor = bgColor),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text(
                refreshStatus.message,
                modifier = Modifier.padding(12.dp),
                style = MaterialTheme.typography.bodySmall,
                color = textColor
            )
        }
    }

    Spacer(modifier = Modifier.height(16.dp))

    OutlinedButton(
        onClick = onLogout,
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.outlinedButtonColors(contentColor = DenyRed)
    ) {
        Text("Sign out")
    }
}
