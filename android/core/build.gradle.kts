import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    alias(libs.plugins.kotlin.jvm)
}

dependencies {
    // The app module supplies `onnxruntime-android` at runtime; the JVM artifact
    // exposes the identical `ai.onnxruntime` API. Keeping it `compileOnly` here
    // is what stops both copies from landing on one classpath, where the AAR
    // (which carries no desktop native library) can shadow the JVM jar and fail
    // the tests with an UnsatisfiedLinkError that looks like a code bug.
    compileOnly(libs.onnxruntime.jvm)

    testImplementation(libs.onnxruntime.jvm)
    testImplementation(libs.kotlinx.serialization.json)
    testImplementation(kotlin("test"))
}

// 17 for Android's sake, not the desktop's: the app module will target it.
kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

tasks.test {
    useJUnitPlatform()

    // The tests load the real models and the real fixture. Both live outside
    // this module — the models are shared with the app's assets, the fixture is
    // shared with the Python generator that wrote it — so their locations are
    // passed in rather than duplicated under src/test/resources.
    systemProperty("yammer.models.dir", rootProject.layout.projectDirectory.dir("models").asFile.absolutePath)
    systemProperty(
        "yammer.fixtures.dir",
        rootProject.layout.projectDirectory.dir("../fixtures").asFile.canonicalPath,
    )

    testLogging {
        events("failed")
        showStandardStreams = true
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
