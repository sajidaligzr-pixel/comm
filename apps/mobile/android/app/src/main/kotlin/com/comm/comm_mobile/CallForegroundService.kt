package com.comm.comm_mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Reported live: "when the screen turns off the voice does not go" / "if I minimize
 * the app the voice also does not go during the call." Root cause confirmed by
 * reading this app's own manifest and call code: `flutter_webrtc`'s audio engine
 * (features/calls/call_controller.dart) runs entirely inside this app's normal
 * process, and this app had NO foreground service covering an active call — only
 * LocationForegroundService's `location` type existed. Without one, Android's
 * background execution limits (Doze / App Standby, tightened further on every
 * release since Android 9) throttle or fully suspend this process's CPU the
 * instant the screen locks or the app is backgrounded, which stops the WebRTC
 * audio pipeline from running at all — not a WebRTC bug, a missing piece of this
 * app's own Android integration. `flutter_callkit_incoming`'s self-managed
 * ConnectionService (pubspec.yaml's own comment) covers showing the incoming-call
 * UI/ringing, not this: it doesn't hold a foreground-service-backed "active call in
 * progress" state for the media itself.
 *
 * Deliberately as minimal as a foreground service can be — no ticking timer, no
 * network I/O (contrast LocationForegroundService, which genuinely has ongoing work
 * to do every tick). Holding ANY foreground service of the right type in this
 * process is what exempts the *whole process* from Doze/App Standby for as long as
 * it runs; the actual audio work keeps happening in the already-running Dart/native
 * WebRTC engine exactly as it does in the foreground, this service's only job is to
 * keep that engine's process alive and unthrottled. `FOREGROUND_SERVICE_TYPE_MICROPHONE`
 * (not `phoneCall`) — `phoneCall` requires this app to hold a Telecom
 * `ConnectionService`-backed call role Android grants to actual dialer/self-managed-
 * calling-role apps; `microphone` accurately describes what this app is really doing
 * (an ordinary RECORD_AUDIO-holding app with an in-progress call) without depending
 * on how deep flutter_callkit_incoming's own ConnectionService integration goes.
 *
 * Started the instant a call becomes genuinely active (this device's own accept, or
 * the remote side answering this device's own outgoing call) and stopped the instant
 * that call ends for any reason — see call_controller.dart's own call sites.
 */
class CallForegroundService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        try {
            startForegroundCompat()
        } catch (e: Exception) {
            // Mirrors LocationForegroundService's own defensive pattern for this call —
            // if this fails, the call's own audio simply behaves as it did before this
            // fix (no worse), not a reason to crash the whole call.
            Log.w(TAG, "startForeground failed: ${e.message}")
            stopSelf()
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    private fun startForegroundCompat() {
        val channelId = "comm_call"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(channelId) == null) {
                val channel =
                    NotificationChannel(channelId, "Ongoing call", NotificationManager.IMPORTANCE_LOW)
                channel.description = "Keeps call audio running in the background"
                manager.createNotificationChannel(channel)
            }
        }

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val piFlags =
            PendingIntent.FLAG_UPDATE_CURRENT or
                (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_IMMUTABLE else 0)
        val pendingIntent = PendingIntent.getActivity(this, 0, launchIntent, piFlags)

        val notification: Notification =
            NotificationCompat.Builder(this, channelId)
                .setContentTitle("Comm")
                .setContentText("Call in progress")
                .setSmallIcon(android.R.drawable.ic_menu_call)
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        private const val TAG = "CallFgService"
        private const val NOTIFICATION_ID = 4300

        fun start(context: Context) {
            context.startForegroundService(Intent(context, CallForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, CallForegroundService::class.java))
        }
    }
}
