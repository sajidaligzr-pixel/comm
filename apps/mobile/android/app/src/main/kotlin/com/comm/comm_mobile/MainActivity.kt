package com.comm.comm_mobile

// local_auth (features/auth/biometric_unlock.dart) requires the host Activity to be
// a FragmentActivity — its Android implementation shows the OS biometric prompt via
// FragmentManager, and calling authenticate() against a plain FlutterActivity throws
// at runtime the first time it's invoked, not at build time (see local_auth's own
// README, "Activity Changes"). FlutterFragmentActivity is a drop-in replacement for
// FlutterActivity otherwise — nothing else in this app depends on the distinction.
import io.flutter.embedding.android.FlutterFragmentActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel

/** Channel name mirrors the Dart-side constant in
 * lib/features/location/location_service.dart — keep the two in sync. */
private const val LOCATION_SERVICE_CHANNEL = "comm/location_service"

class MainActivity : FlutterFragmentActivity() {
    // Bridges location_service.dart to LocationForegroundService — see that
    // service's own docstring for why this exists as a plain native Service
    // rather than another Flutter/plugin-based background mechanism.
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)

        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, LOCATION_SERVICE_CHANNEL)
            .setMethodCallHandler { call, result ->
                when (call.method) {
                    "start" -> {
                        LocationForegroundService.start(applicationContext)
                        result.success(null)
                    }
                    "stop" -> {
                        LocationForegroundService.stop(applicationContext)
                        result.success(null)
                    }
                    "setSession" -> {
                        val args = call.arguments as? Map<*, *>
                        LocationForegroundService.saveSession(
                            applicationContext,
                            cookieHeader = args?.get("cookieHeader") as? String ?: "",
                            csrfToken = args?.get("csrfToken") as? String ?: "",
                            baseUrl = args?.get("baseUrl") as? String ?: "",
                        )
                        result.success(null)
                    }
                    "clearSession" -> {
                        LocationForegroundService.clearSession(applicationContext)
                        result.success(null)
                    }
                    else -> result.notImplemented()
                }
            }
    }
}
