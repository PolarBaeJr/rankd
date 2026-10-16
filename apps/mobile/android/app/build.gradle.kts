import java.net.URI
import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// The two public Supabase values and the optional club website URL come from
// local.properties (gitignored), or a Gradle property of the same name for CI.
// A missing value builds anyway, as an empty string: a missing Supabase value
// shows the configuration screen rather than a client pointed at nothing, and
// a missing website URL only hides passkey sign-in.
val localProperties = Properties().apply {
    val file = rootProject.file("local.properties")
    if (file.isFile) file.inputStream().use { load(it) }
}

fun configValue(name: String): String =
    localProperties.getProperty(name) ?: providers.gradleProperty(name).orNull ?: ""

fun buildConfigString(value: String): String =
    "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

android {
    namespace = "com.clubladder.app"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.clubladder.app"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "0.1.0"

        buildConfigField("String", "SUPABASE_URL", buildConfigString(configValue("badminton.supabaseUrl")))
        buildConfigField("String", "SUPABASE_ANON_KEY", buildConfigString(configValue("badminton.supabaseAnonKey")))
        buildConfigField("String", "SITE_URL", buildConfigString(configValue("badminton.siteUrl")))

        // The App Links host. A build with no site URL claims a host that can never resolve.
        manifestPlaceholders["siteHost"] =
            runCatching { URI(configValue("badminton.siteUrl")).host }.getOrNull()?.takeIf { it.isNotBlank() }
                ?: "example.invalid"
    }

    buildFeatures {
        compose = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
        }
    }

    lint {
        abortOnError = true
        checkReleaseBuilds = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation(platform(libs.compose.bom))
    implementation(libs.compose.ui)
    implementation(libs.compose.foundation)
    implementation(libs.compose.material3)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.viewmodel.compose)
    implementation(libs.lifecycle.runtime.compose)
    implementation(libs.lifecycle.process)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.credentials)
    implementation(libs.credentials.play.services.auth)
    implementation(libs.play.services.code.scanner)
    implementation(libs.qrcodegen)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
}
