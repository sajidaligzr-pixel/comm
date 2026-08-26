package com.comm.comm_mobile

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.Location
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.CurrentLocationRequest
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import com.google.android.gms.tasks.CancellationTokenSource
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.Executors
import org.json.JSONObject

/**
 * Hand-written replacement for `flutter_background_service` (see
 * `location_service.dart`'s docstring for the full story) — a plain Android
 * foreground service that captures and posts one location fix per tick, entirely
 * in Kotlin. Deliberately touches no Flutter API and creates no `FlutterEngine`:
 * that is precisely the thing this file exists to avoid, since constructing a
 * second engine (and the automatic re-registration of every plugin this app uses
 * that comes with it, with no Activity ever attached) is the confirmed cause of
 * the crash-on-open bug this service replaces — read directly out of
 * `flutter_background_service_android`'s own `BackgroundService.java`, not
 * guessed at.
 *
 * Session material (a raw `Cookie` header value + the CSRF cookie's value) is
 * handed in from Dart via `MainActivity`'s MethodChannel handler
 * (`location_service.dart` reads it from the same cookie jar `ApiClient` already
 * persists to disk) and kept here in a plain `SharedPreferences` file — no
 * different in sensitivity from that cookie jar's own on-disk storage
 * (`cookie_jar`'s `FileStorage`, also unencrypted), so this isn't a new exposure.
 *
 * Deliberately does NOT attempt its own token refresh on a 401: refresh tokens
 * rotate single-use-per-refresh (docs/07-auth-architecture.md), so an independent
 * refresh attempt from here racing the app's own would risk the server's reuse-
 * detection treating it as theft and revoking the whole session — a forced sign-
 * out is a much worse outcome than a location update quietly going stale. In
 * practice this means reporting keeps working for as long as the access token
 * stays valid since the app was last actually used (~15 minutes, refreshed by
 * `ApiClient.onTokensRefreshed` → `LocationService.refreshSession` every time
 * that happens), and simply resumes next time the app is opened rather than ever
 * risking that.
 */
class LocationForegroundService : Service() {
    private val handler = Handler(Looper.getMainLooper())
    private val executor = Executors.newSingleThreadExecutor()
    private var running = false

    private val tick =
        object : Runnable {
            override fun run() {
                executor.execute { reportOnce() }
                if (running) handler.postDelayed(this, TICK_INTERVAL_MS)
            }
        }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        try {
            startForegroundCompat()
        } catch (e: Exception) {
            // Mirrors flutter_background_service's own defensive pattern for this
            // exact call (updateNotificationInfo's SecurityException catch) — the
            // one difference is this failure quietly stops just this service
            // rather than being swallowed silently, since there's no Dart
            // try/catch anywhere else in the call chain to rely on.
            Log.w(TAG, "startForeground failed, stopping: ${e.message}")
            stopSelf()
            return
        }
        running = true
        handler.post(tick)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int = START_NOT_STICKY

    override fun onDestroy() {
        running = false
        handler.removeCallbacks(tick)
        super.onDestroy()
    }

    private fun startForegroundCompat() {
        val channelId = "comm_location"
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(channelId) == null) {
                val channel =
                    NotificationChannel(channelId, "Location sharing", NotificationManager.IMPORTANCE_LOW)
                channel.description = "Sharing your live location"
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
                .setContentText("Sharing your location")
                .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                .setOngoing(true)
                .setContentIntent(pendingIntent)
                .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ServiceCompat.startForeground(
                this,
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION,
            )
        } else {
            @Suppress("DEPRECATION")
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    // Permission state is checked explicitly, immediately above the one call that
    // needs it, on every tick (fail-closed if it's ever revoked mid-run) —
    // @SuppressLint here is belt-and-suspenders on top of that real runtime
    // check, not a substitute for it.
    @SuppressLint("MissingPermission")
    private fun reportOnce() {
        try {
            val prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val cookieHeader = prefs.getString(KEY_COOKIE, null)
            val csrfToken = prefs.getString(KEY_CSRF, null)
            val baseUrl = prefs.getString(KEY_BASE_URL, null)
            if (cookieHeader.isNullOrEmpty() || baseUrl.isNullOrEmpty()) return

            val fineGranted =
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED
            val coarseGranted =
                ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
                    PackageManager.PERMISSION_GRANTED
            if (!fineGranted && !coarseGranted) return

            val request =
                CurrentLocationRequest.Builder()
                    .setPriority(
                        if (fineGranted) Priority.PRIORITY_HIGH_ACCURACY else Priority.PRIORITY_BALANCED_POWER_ACCURACY,
                    )
                    .build()

            LocationServices.getFusedLocationProviderClient(this)
                .getCurrentLocation(request, CancellationTokenSource().token)
                .addOnSuccessListener { location ->
                    if (location != null) executor.execute { post(baseUrl, cookieHeader, csrfToken, location) }
                }
                .addOnFailureListener { e -> Log.w(TAG, "getCurrentLocation failed: ${e.message}") }
        } catch (e: Exception) {
            Log.w(TAG, "reportOnce failed: ${e.message}")
        }
    }

    /** Field names/shape mirror `packages/types/src/locations.ts`'s `LocationPing`
     * exactly (its three optional fields are `nullable()`, not `optional()` — they
     * must be present as explicit JSON `null`, not omitted, or the server rejects
     * the body). `recordedAt` matches Dart's own `toUtc().toIso8601String()`
     * shape — `Instant.toString()` is already UTC with a trailing `Z`. */
    private fun post(baseUrl: String, cookieHeader: String, csrfToken: String?, location: Location) {
        try {
            val body =
                JSONObject().apply {
                    put("latitude", location.latitude)
                    put("longitude", location.longitude)
                    put("accuracyM", if (location.hasAccuracy()) location.accuracy.toDouble() else JSONObject.NULL)
                    put("headingDeg", if (location.hasBearing()) location.bearing.toDouble() else JSONObject.NULL)
                    put("speedMps", if (location.hasSpeed()) location.speed.toDouble() else JSONObject.NULL)
                    put("recordedAt", Instant.ofEpochMilli(location.time).toString())
                }

            val connection = URL("$baseUrl/api/locations").openConnection() as HttpURLConnection
            try {
                connection.requestMethod = "POST"
                connection.doOutput = true
                connection.connectTimeout = 15_000
                connection.readTimeout = 15_000
                connection.setRequestProperty("Content-Type", "application/json")
                connection.setRequestProperty("Cookie", cookieHeader)
                if (!csrfToken.isNullOrEmpty()) connection.setRequestProperty("x-csrf-token", csrfToken)

                connection.outputStream.use { stream ->
                    OutputStreamWriter(stream).use { writer ->
                        writer.write(body.toString())
                        writer.flush()
                    }
                }

                val code = connection.responseCode
                if (code !in 200..299) Log.w(TAG, "Location post failed with status $code")
            } finally {
                connection.disconnect()
            }
        } catch (e: Exception) {
            // Best-effort, same posture as every other periodic background task in
            // this app (see location_service.dart) — a single failed tick (no
            // signal, offline, expired token) just waits for the next one.
            Log.w(TAG, "Location post failed: ${e.message}")
        }
    }

    companion object {
        private const val TAG = "LocationFgService"
        private const val NOTIFICATION_ID = 4200
        private const val TICK_INTERVAL_MS = 60_000L
        private const val PREFS_NAME = "comm_location_prefs"
        private const val KEY_COOKIE = "cookie_header"
        private const val KEY_CSRF = "csrf_token"
        private const val KEY_BASE_URL = "base_url"

        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, LocationForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, LocationForegroundService::class.java))
        }

        fun saveSession(context: Context, cookieHeader: String, csrfToken: String, baseUrl: String) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .edit()
                .putString(KEY_COOKIE, cookieHeader)
                .putString(KEY_CSRF, csrfToken)
                .putString(KEY_BASE_URL, baseUrl)
                .apply()
        }

        fun clearSession(context: Context) {
            context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE).edit().clear().apply()
        }
    }
}
