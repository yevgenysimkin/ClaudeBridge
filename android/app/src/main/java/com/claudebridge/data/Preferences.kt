package com.claudebridge.data

import android.content.Context
import android.content.SharedPreferences

/**
 * Thin wrapper over SharedPreferences for relay connection and Chromattica auth.
 */
class Preferences(context: Context) {
    private val prefs: SharedPreferences =
        context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    /** Relay WebSocket URL (set from Chromattica account after OTP login). */
    var relayUrl: String
        get() = prefs.getString(KEY_RELAY_URL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_RELAY_URL, value).apply()

    /** Relay auth token (set from Chromattica account after OTP login). */
    var authToken: String
        get() = prefs.getString(KEY_AUTH_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_AUTH_TOKEN, value).apply()

    /** Chromattica session token (Bearer token for API calls). */
    var sessionToken: String
        get() = prefs.getString(KEY_SESSION_TOKEN, "") ?: ""
        set(value) = prefs.edit().putString(KEY_SESSION_TOKEN, value).apply()

    /** Chromattica account email. */
    var email: String
        get() = prefs.getString(KEY_EMAIL, "") ?: ""
        set(value) = prefs.edit().putString(KEY_EMAIL, value).apply()

    /** True if relay credentials are configured (logged in AND relay bound). */
    val isConfigured: Boolean
        get() = relayUrl.isNotBlank() && authToken.isNotBlank()

    /** True if the user has authenticated with Chromattica. */
    val isLoggedIn: Boolean
        get() = sessionToken.isNotBlank() && email.isNotBlank()

    /** Clear all stored credentials (logout). */
    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "claude_bridge"
        private const val KEY_RELAY_URL = "relay_url"
        private const val KEY_AUTH_TOKEN = "auth_token"
        private const val KEY_SESSION_TOKEN = "session_token"
        private const val KEY_EMAIL = "email"
    }
}
