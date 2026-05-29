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

    /**
     * Last model selected in the "Start new session" sheet — pre-populates the
     * dropdown the next time the user opens it.
     */
    var lastModel: String
        get() = prefs.getString(KEY_LAST_MODEL, DEFAULT_MODEL) ?: DEFAULT_MODEL
        set(value) = prefs.edit().putString(KEY_LAST_MODEL, value).apply()

    /** Last value of the --dangerously-skip-permissions checkbox in the sheet. */
    var skipPermsPreference: Boolean
        get() = prefs.getBoolean(KEY_SKIP_PERMS, false)
        set(value) = prefs.edit().putBoolean(KEY_SKIP_PERMS, value).apply()

    /**
     * Last effort level selected in the sheet (e.g. "high"). Empty = none/
     * model-default. Pre-populates the effort dropdown next time.
     */
    var lastEffort: String
        get() = prefs.getString(KEY_LAST_EFFORT, "") ?: ""
        set(value) = prefs.edit().putString(KEY_LAST_EFFORT, value).apply()

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
        private const val KEY_LAST_MODEL = "last_model"
        private const val KEY_LAST_EFFORT = "last_effort"
        private const val KEY_SKIP_PERMS = "skip_perms"
        const val DEFAULT_MODEL = "claude-opus-4-7"
    }
}
