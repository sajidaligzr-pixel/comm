pluginManagement {
    val flutterSdkPath =
        run {
            val properties = java.util.Properties()
            file("local.properties").inputStream().use { properties.load(it) }
            val flutterSdkPath = properties.getProperty("flutter.sdk")
            require(flutterSdkPath != null) { "flutter.sdk not set in local.properties" }
            flutterSdkPath
        }

    includeBuild("$flutterSdkPath/packages/flutter_tools/gradle")

    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

plugins {
    id("dev.flutter.flutter-plugin-loader") version "1.0.0"
    id("com.android.application") version "8.11.1" apply false
    id("org.jetbrains.kotlin.android") version "2.2.20" apply false
    // Push notifications (FCM) — reads android/app/google-services.json at build
    // time to wire the app to the comm-5d11c Firebase project. `apply false` here,
    // actually applied in app/build.gradle.kts only (the one module that has the
    // config file), same pattern as the two plugins above.
    id("com.google.gms.google-services") version "4.4.2" apply false
}

include(":app")
