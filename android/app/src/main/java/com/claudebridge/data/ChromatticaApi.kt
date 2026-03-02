package com.claudebridge.data

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import android.util.Log
import java.util.concurrent.TimeUnit

/**
 * Client for Chromattica API authentication (OTP login).
 * After successful OTP verify, extracts claudebridgeConfig from the account.
 */
object ChromatticaApi {

    private const val BASE_URL = "https://api.chromattica.com"
    private const val REQUEST_OTP_PATH = "/api/auth/request-otp"
    private const val VERIFY_OTP_PATH = "/api/auth/verify-otp"
    private const val SYNC_PATH = "/api/auth/sync"
    private const val TELEMETRY_PATH = "/api/telemetry/event"
    private const val TIMEOUT_SECONDS = 15L

    private val client = OkHttpClient.Builder()
        .connectTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .readTimeout(TIMEOUT_SECONDS, TimeUnit.SECONDS)
        .build()

    private val JSON_MEDIA_TYPE = "application/json; charset=utf-8".toMediaType()

    /** Request an OTP code be sent to the given email. */
    suspend fun requestOtp(email: String): OtpRequestResult = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("email", email)
        }.toString().toRequestBody(JSON_MEDIA_TYPE)

        val request = Request.Builder()
            .url("$BASE_URL$REQUEST_OTP_PATH")
            .post(body)
            .build()

        val response = client.newCall(request).execute()
        val responseBody = response.body?.string() ?: "{}"
        val json = JSONObject(responseBody)

        if (response.isSuccessful) {
            OtpRequestResult.Success
        } else if (response.code == 429) {
            val retryAfter = json.optInt("retryAfter", 60)
            OtpRequestResult.RateLimited(retryAfter)
        } else {
            OtpRequestResult.Error(json.optString("error", "Failed to send code"))
        }
    }

    /**
     * Refresh ClaudeBridge config from server using existing session token.
     * Pass current auth token so we can detect if the server's token differs.
     */
    suspend fun refreshConfig(
        sessionToken: String,
        currentAuthToken: String = ""
    ): ConfigRefreshResult = withContext(Dispatchers.IO) {
        val body = JSONObject().toString().toRequestBody(JSON_MEDIA_TYPE)

        val request = Request.Builder()
            .url("$BASE_URL$SYNC_PATH")
            .post(body)
            .header("Authorization", "Bearer $sessionToken")
            .build()

        try {
            val response = client.newCall(request).execute()
            val responseBody = response.body?.string() ?: "{}"
            val json = JSONObject(responseBody)

            when {
                response.isSuccessful -> {
                    val account = json.getJSONObject("account")
                    val cbConfig = account.optJSONObject("claudebridgeConfig")

                    val relayUrl = cbConfig?.optString("relayUrl", "") ?: ""
                    val authToken = cbConfig?.optString("relayAuthToken", "") ?: ""

                    ConfigRefreshResult.Success(
                        relayUrl = relayUrl,
                        relayAuthToken = authToken,
                        serverHadRelayUrl = relayUrl.isNotBlank(),
                        serverHadAuthToken = authToken.isNotBlank(),
                        tokenChanged = currentAuthToken.isNotBlank() && authToken.isNotBlank()
                                && currentAuthToken != authToken
                    )
                }
                response.code == 401 -> {
                    ConfigRefreshResult.SessionExpired
                }
                else -> {
                    ConfigRefreshResult.Error(json.optString("error", "Sync failed"))
                }
            }
        } catch (e: Exception) {
            ConfigRefreshResult.NetworkError(e.message ?: "Unknown network error")
        }
    }

    /** Fire-and-forget telemetry event. Never throws. */
    fun reportEvent(event: String, data: Map<String, Any?> = emptyMap(), email: String? = null) {
        Thread {
            try {
                val payload = JSONObject().apply {
                    put("source", "android")
                    put("event", event)
                    put("data", JSONObject(data))
                    if (email != null) put("email", email)
                }
                val body = payload.toString().toRequestBody(JSON_MEDIA_TYPE)
                val request = Request.Builder()
                    .url("$BASE_URL$TELEMETRY_PATH")
                    .post(body)
                    .build()
                client.newCall(request).execute().close()
            } catch (e: Exception) {
                Log.d("ChromatticaApi", "Telemetry send failed: ${e.message}")
            }
        }.start()
    }

    /** Verify an OTP code and return session + account data. */
    suspend fun verifyOtp(email: String, code: String): OtpVerifyResult = withContext(Dispatchers.IO) {
        val body = JSONObject().apply {
            put("email", email)
            put("code", code)
        }.toString().toRequestBody(JSON_MEDIA_TYPE)

        val request = Request.Builder()
            .url("$BASE_URL$VERIFY_OTP_PATH")
            .post(body)
            .build()

        val response = client.newCall(request).execute()
        val responseBody = response.body?.string() ?: "{}"
        val json = JSONObject(responseBody)

        when {
            response.isSuccessful -> {
                val sessionToken = json.getString("sessionToken")
                val account = json.getJSONObject("account")
                val cbConfig = account.optJSONObject("claudebridgeConfig")

                OtpVerifyResult.Success(
                    sessionToken = sessionToken,
                    email = account.getString("email"),
                    relayUrl = cbConfig?.optString("relayUrl", "") ?: "",
                    relayAuthToken = cbConfig?.optString("relayAuthToken", "") ?: ""
                )
            }
            response.code == 401 -> {
                val remaining = json.optInt("attemptsRemaining", 0)
                OtpVerifyResult.InvalidCode(remaining)
            }
            response.code == 410 -> {
                val errorCode = json.optString("code", "expired")
                OtpVerifyResult.Expired(errorCode)
            }
            else -> {
                OtpVerifyResult.Error(json.optString("error", "Verification failed"))
            }
        }
    }
}

sealed class OtpRequestResult {
    data object Success : OtpRequestResult()
    data class RateLimited(val retryAfterSeconds: Int) : OtpRequestResult()
    data class Error(val message: String) : OtpRequestResult()
}

sealed class OtpVerifyResult {
    data class Success(
        val sessionToken: String,
        val email: String,
        val relayUrl: String,
        val relayAuthToken: String
    ) : OtpVerifyResult()
    data class InvalidCode(val attemptsRemaining: Int) : OtpVerifyResult()
    data class Expired(val reason: String) : OtpVerifyResult()
    data class Error(val message: String) : OtpVerifyResult()
}

sealed class ConfigRefreshResult {
    data class Success(
        val relayUrl: String,
        val relayAuthToken: String,
        val serverHadRelayUrl: Boolean,
        val serverHadAuthToken: Boolean,
        val tokenChanged: Boolean
    ) : ConfigRefreshResult()
    data object SessionExpired : ConfigRefreshResult()
    data class Error(val message: String) : ConfigRefreshResult()
    data class NetworkError(val message: String) : ConfigRefreshResult()
}
