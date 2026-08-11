rootProject.name = "yammer-android"

// `core` is deliberately a plain Kotlin/JVM module rather than part of the app:
// the feature pipeline has no Android dependencies, so its tests run on the
// desktop JVM against the same ONNX models the phone will load. The Android
// `app` module arrives in Phase 2 and depends on this one.
include(":core")

dependencyResolutionManagement {
    repositories {
        mavenCentral()
        google()
    }
}
