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
