// Settings shared by every module. Module build files add only their own dependencies.

plugins {
    base
}

val javaLevel = 25

allprojects {
    group = "gtfseditor.router"
    version = "0.1.0-SNAPSHOT"
}

subprojects {
    apply(plugin = "java-library")

    val libs = rootProject.extensions.getByType<VersionCatalogsExtension>().named("libs")

    tasks.withType<JavaCompile>().configureEach {
        // Compile for Java 25 with whatever JDK runs Gradle (25 or newer). No toolchain is
        // declared, so nothing is downloaded and a machine with only Java 26 can build.
        options.release = javaLevel
        options.encoding = "UTF-8"
        options.compilerArgs.addAll(listOf("-Xlint:all", "-Werror"))
    }

    dependencies {
        "testImplementation"(platform(libs.findLibrary("junit-bom").get()))
        "testImplementation"(libs.findLibrary("junit-jupiter").get())
        "testRuntimeOnly"(libs.findLibrary("junit-platform-launcher").get())
    }

    tasks.withType<Test>().configureEach {
        useJUnitPlatform()
        testLogging {
            events("passed", "skipped", "failed")
        }
    }
}
