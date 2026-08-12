rootProject.name = "yammer-android"

// `core` is deliberately a plain Kotlin/JVM module rather than part of the app:
// the feature pipeline has no Android dependencies, so its tests run on the
// desktop JVM against the same ONNX models the phone will load. `app` depends
// on it.
include(":core")
include(":app")

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
    }
}
