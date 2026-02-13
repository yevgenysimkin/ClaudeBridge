package com.claudebridge.ui.theme

import android.app.Activity
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.SideEffect
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalView
import androidx.core.view.WindowCompat

private val DarkColorScheme = darkColorScheme(
    primary = ClaudePrimary,
    onPrimary = ClaudeOnBackground,
    secondary = ClaudeSecondary,
    background = ClaudeBackground,
    surface = ClaudeSurface,
    surfaceVariant = ClaudeSurfaceVariant,
    onBackground = ClaudeOnBackground,
    onSurface = ClaudeOnSurface,
    onSurfaceVariant = ClaudeOnSurface,
    error = DenyRed
)

@Composable
fun ClaudeBridgeTheme(content: @Composable () -> Unit) {
    val view = LocalView.current
    if (!view.isInEditMode) {
        SideEffect {
            val window = (view.context as Activity).window
            window.statusBarColor = ClaudeBackground.toArgb()
            WindowCompat.getInsetsController(window, view).isAppearanceLightStatusBars = false
        }
    }

    MaterialTheme(
        colorScheme = DarkColorScheme,
        typography = Typography(),
        content = content
    )
}
