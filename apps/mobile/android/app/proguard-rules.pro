# Release-build keep rules — Flutter's own default rules (keep the engine/embedding)
# come bundled with the Flutter Gradle plugin automatically; everything below is for
# plugins in THIS app that are known to break under R8 minification without an
# explicit rule, confirmed before enabling isMinifyEnabled (build.gradle.kts) rather
# than after a silent field-of-a-plugin-that-worked-fine-in-debug bug report:
#
# - local_auth: confirmed documented crash without this exact rule — R8 strips a
#   lifecycle-observer interface implementation and the plugin throws
#   `IllegalAccessError` the moment biometric auth is invoked (flutter/flutter#65381).
#   This is real, not theoretical: biometric_unlock.dart's authenticate() calls run
#   straight into this class.
-keep class io.flutter.plugins.localauth.** { *; }

# - flutter_webrtc: the plugin's own android/build.gradle already declares these as
#   `consumerProguardFiles`, so Gradle auto-merges them — kept here explicitly too as
#   a zero-cost safety net, since a silently-stripped JNI-bridged class in a calling
#   feature is exactly the kind of failure that's easy to ship without noticing (no
#   build error, just a runtime crash the first time a call is placed).
-keep class com.cloudwebrtc.webrtc.** { *; }
-keep class org.webrtc.** { *; }

# - flutter_secure_storage's Android backend (AndroidOptions(encryptedSharedPreferences:
#   true) — every blob this app stores locally goes through this, see
#   storage/blob_store.dart) is backed by Jetpack Security / Google Tink, which has a
#   history of R8 stripping fields from its protobuf-generated key-format classes
#   (google/tink#361) — fixed upstream a while ago, but kept here defensively since a
#   break here means every locally-stored key/session/identity becomes unreadable, not
#   a cosmetic bug.
-keep class com.google.crypto.tink.** { *; }
-keepclassmembers class * extends com.google.protobuf.GeneratedMessageLite {
    <fields>;
}

# - flutter_local_notifications (features/notifications/) uses GSON internally to
#   persist scheduled-notification state; its own README explicitly calls out that
#   R8 needs these standard GSON rules added by the CONSUMING app (not bundled as a
#   consumerProguardFiles the way flutter_webrtc's are) — the canonical rule set
#   from GSON's own proguard example, not something specific to this app.
-keepattributes Signature
-keepattributes *Annotation*
-dontwarn sun.misc.**
-keep class * implements com.google.gson.TypeAdapterFactory
-keep class * implements com.google.gson.JsonSerializer
-keep class * implements com.google.gson.JsonDeserializer
-keep,allowobfuscation,allowshrinking class com.google.gson.reflect.TypeToken
-keep,allowobfuscation,allowshrinking class * extends com.google.gson.reflect.TypeToken

# - flutter_callkit_incoming (features/calls/call_kit.dart) — its own README
#   explicitly calls out this exact rule for R8/minified builds, to avoid its
#   json_annotation-generated CallKitParams/AndroidParams/etc. (de)serializers
#   losing fields to obfuscation.
-keep class com.hiennv.flutter_callkit_incoming.** { *; }

# - geolocator_android (used by the app's own foreground location capture — see
#   location_service.dart's docstring) — ships NO consumer-rules.pro of its own
#   (confirmed: nothing under its android/ dir), unlike every other plugin in
#   this file, so this app has to supply whatever R8 needs itself or get
#   nothing at all. Found live: a release build crashed on login the moment
#   isMinifyEnabled's R8 pass applied to it — exactly the same class of bug
#   local_auth's rule above documents. Broad keep on both the plugin's own
#   package and the Play Services Location classes it calls into
#   (FusedLocationProviderClient callbacks are exactly the kind of
#   anonymous-class/listener-interface shape R8 is known to strip) — the same
#   Play Services classes LocationForegroundService.kt now also calls directly,
#   so this rule covers both call sites.
-keep class com.baseflow.geolocator.** { *; }
-keep class com.google.android.gms.location.** { *; }

# flutter_background_service is gone as of build 1.0.0+14 (see
# location_service.dart's docstring for why) — its keep rule is removed along
# with it; LocationForegroundService.kt is this app's own class, already kept
# by the Android Gradle Plugin's default rules for anything declared in
# AndroidManifest.xml.
