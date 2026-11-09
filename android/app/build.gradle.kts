plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

// The bundled web half (runtime/, host.js, Seed/), built by ../scripts/build-mobile-host.mjs
// into app/build/generated/quire/assets on every build, the way the iOS target's "Build mobile
// host" phase does. It needs node, not the network.
val generatedAssets = layout.buildDirectory.dir("generated/quire/assets")
val buildMobileHost by tasks.registering(Exec::class) {
    description = "Builds runtime/, host.js and the seed vault into the app's assets"
    workingDir = rootDir
    commandLine("bash", "${rootDir}/scripts/build-mobile-host.sh")
    // Always run: it is fast, and runtime.js edits must land in the next APK.
    outputs.upToDateWhen { false }
}

android {
    // Internal ids stay "quire" (docs/contract.md, "Naming: public vs internal").
    namespace = "org.harborapps.quire"
    compileSdk = 36

    defaultConfig {
        // Same as the iOS bundle id (ios/project.yml).
        applicationId = "org.harborapps.quire.mobile"
        minSdk = 26
        targetSdk = 36
        versionCode = 301
        versionName = "0.3.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        compose = true
        buildConfig = true
    }
    sourceSets["main"].assets.srcDir(generatedAssets)
    androidResources {
        // Pages, fonts and the seed vault are served from assets byte for byte.
        noCompress += listOf("js", "mjs", "css", "woff2", "html", "md", "json")
        // aapt skips dot-files by default; the seed vault's .noteblock / .quire manifests must ship.
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:!CVS:!thumbs.db:!picasa.ini:!*~"
    }
}

tasks.named("preBuild") { dependsOn(buildMobileHost) }

kotlin {
    compilerOptions {
        jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)
    implementation(libs.androidx.lifecycle.runtime.compose)
    implementation(libs.androidx.lifecycle.viewmodel.compose)
    implementation(libs.androidx.lifecycle.process)
    implementation(libs.androidx.activity.compose)
    implementation(platform(libs.androidx.compose.bom))
    implementation(libs.androidx.compose.ui)
    implementation(libs.androidx.compose.ui.tooling.preview)
    implementation(libs.androidx.compose.material3)
    implementation(libs.androidx.compose.material.icons.extended)
    implementation(libs.androidx.navigation.compose)
    implementation(libs.androidx.webkit)
    implementation(libs.androidx.javascriptengine)
    implementation(libs.androidx.concurrent.futures.ktx)
    implementation(libs.kotlinx.serialization.json)
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    debugImplementation(libs.androidx.compose.ui.tooling)
}
