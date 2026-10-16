// AGP 9 compiles Kotlin itself, so the kotlin-android plugin is never applied.
// The Kotlin Gradle plugin on the classpath pins the compiler AGP uses to the
// same version as the compose and serialization plugins below.
buildscript {
    dependencies {
        classpath(libs.kotlin.gradle.plugin)
    }
}

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
