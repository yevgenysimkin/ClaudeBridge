package com.claudebridge

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class ClaudeBridgeApp : Application() {

    override fun onCreate() {
        super.onCreate()
        createNotificationChannels()
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        // Persistent foreground service notification
        val connectionChannel = NotificationChannel(
            CHANNEL_CONNECTION,
            "Connection",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Persistent notification while connected to relay"
            setShowBadge(false)
        }

        // Attention-needed notifications (permission requests, user questions)
        val attentionChannel = NotificationChannel(
            CHANNEL_ATTENTION,
            "Needs Attention",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Permission requests and questions from agents"
            enableVibration(true)
        }

        manager.createNotificationChannels(listOf(connectionChannel, attentionChannel))
    }

    companion object {
        const val CHANNEL_CONNECTION = "connection"
        const val CHANNEL_ATTENTION = "attention"
    }
}
