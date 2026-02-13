package com.claudebridge.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Thin wrapper over SharedPreferences for relay connection settings.
 */
class Preferences(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    var relayUrl: String
        get() = prefs.getString(KEY_RELAY_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_RELAY_URL, value).apply()

    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AUTH_TOKEN, value).apply()

    val isConfigured: Boolean
        get() = relayUrl.isNotBlank() && authToken.isNotBlank()

    companion object {
        private const val PREFS_NAME = "claude_bridge"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
    }
}
