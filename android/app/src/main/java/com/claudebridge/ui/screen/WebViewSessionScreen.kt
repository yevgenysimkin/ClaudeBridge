package com.claudebridge.ui.screen

import android.annotation.SuppressLint
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.systemBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import com.claudebridge.BuildConfig
import org.json.JSONObject

@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebViewSessionScreen(
    relayUrl: String,
    authToken: String,
    channelId: String,
    channelName: String,
    onBack: () -> Unit
) {
    // Android 15+ defaults to edge-to-edge, so the WebView would draw under
    // the system status bar (and bottom gesture pill) and collide with the
    // session header. Reserve the system-bar insets for the WebView.
    AndroidView(
        modifier = Modifier
            .fillMaxSize()
            .windowInsetsPadding(WindowInsets.systemBars),
        factory = { context ->
            // Only expose to chrome://inspect on debug builds. Production
            // APKs ship with this off so a rooted/dev phone can't attach
            // a remote debugger to live PTY traffic.
            WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)
            WebView(context).apply {
                layoutParams = ViewGroup.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT
                )
                settings.javaScriptEnabled = true
                settings.domStorageEnabled = true

                addJavascriptInterface(object {
                    @JavascriptInterface
                    fun goBack() {
                        post { onBack() }
                    }
                }, "__cbAndroid")

                webViewClient = object : WebViewClient() {
                    override fun onPageFinished(view: WebView?, url: String?) {
                        super.onPageFinished(view, url)
                        val config = JSONObject().apply {
                            put("relayUrl", relayUrl)
                            put("relayAuthToken", authToken)
                            put("channelId", channelId)
                            put("channelName", channelName)
                        }
                        val js = "window.__cbConfig = $config; if (window.__cbInit) window.__cbInit();"
                        view?.evaluateJavascript(js, null)
                    }
                }

                loadUrl("file:///android_asset/session.html")
            }
        }
    )
}
