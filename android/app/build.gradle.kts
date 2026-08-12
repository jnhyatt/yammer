import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
}

android {
    namespace = "dev.yammer.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "dev.yammer.android"

        // 33 is Android 13, the floor for LE Audio. This is a scope decision, not
        // a limitation to work around — see voice-opencode-requirements.md §9 and
        // android/README.md. Classic Bluetooth (HFP/SCO) caps the microphone at 8
        // or 16 kHz and that bandwidth is not recoverable downstream.
        minSdk = 33
        targetSdk = 36

        versionCode = 1
        versionName = "0.1-phase2"

        ndk {
            // The ONNX Runtime AAR carries native libraries for four ABIs and is
            // the bulk of the APK. Only arm64 is in scope, and a smaller APK is a
            // faster sideload every time the harness is rebuilt.
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        // No release story yet — Phase 2 is a diagnostic build that gets
        // sideloaded. Minification arrives with the service and the protocol, at
        // which point ONNX Runtime and okhttp both need keep rules.
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    // The models live in `android/models/` rather than under `app/src/main/assets`
    // so there is exactly one copy: the fixture pins their SHA-256, and
    // `:core:test` checks that directory against those digests. Adding it as an
    // asset source means the phone gets the same bytes the tests verified.
    sourceSets["main"].assets.srcDir(rootProject.layout.projectDirectory.dir("models"))
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

dependencies {
    implementation(project(":core"))

    // ONNX Runtime is deliberately *not* here yet. `core` keeps it `compileOnly`,
    // so the app is what has to supply it on device — but only once something
    // runs inference, which is Phase 4. Adding it now costs 28 MB of arm64
    // native library in every sideload of a harness that never calls it.
    //
    // The thing to check before deferring was whether dexing `core` with
    // unresolved `ai.onnxruntime` references produces missing-class warnings. It
    // does not, for a debug build: D8 packages the classes and says nothing.
    // That changes under minification, which is a Phase 4 problem along with the
    // dependency itself.
    implementation(libs.kotlinx.coroutines.android)
}
