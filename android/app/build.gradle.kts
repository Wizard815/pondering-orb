plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("app.cash.paparazzi")   // pictures of the widgets and screens, drawn on the computer (src/test/.../ScreensTest.kt)
}

android {
    namespace = "com.ponderingorb.app"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.ponderingorb.app"
        minSdk = 26
        targetSdk = 35
        versionCode = (System.getenv("ORB_VERSION_CODE") ?: "1").toInt()
        versionName = System.getenv("ORB_VERSION_NAME") ?: "0.1.0"
    }
    // Release builds are signed with your own key when ORB_KEYSTORE is set (docs/apps.md).
    // Without it, the release APK is signed with the debug key so it still installs.
    signingConfigs {
        create("release") {
            val ks = System.getenv("ORB_KEYSTORE")
            if (!ks.isNullOrBlank()) {
                storeFile = file(ks)
                storePassword = System.getenv("ORB_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("ORB_KEY_ALIAS") ?: "orb"
                keyPassword = System.getenv("ORB_KEY_PASSWORD") ?: System.getenv("ORB_KEYSTORE_PASSWORD")
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (System.getenv("ORB_KEYSTORE").isNullOrBlank()) signingConfigs.getByName("debug") else signingConfigs.getByName("release")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
}

dependencies {
    implementation("androidx.core:core-ktx:1.16.0")
    implementation("androidx.work:work-runtime-ktx:2.10.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20240303")
}
