// Benchmarks. For now a single placeholder JMH benchmark that proves the set-up works;
// the demand generator and the whole-run harness arrive in phase 5.

dependencies {
    "implementation"(project(":router-core"))
    "implementation"(libs.jmh.core)
    "annotationProcessor"(libs.jmh.annprocess)
}

tasks.withType<JavaCompile>().configureEach {
    // JMH's annotation processor does not claim every annotation it sees, which javac
    // reports as a "processing" warning; the shared build treats warnings as errors.
    options.compilerArgs.add("-Xlint:-processing")
}

tasks.register<JavaExec>("jmh") {
    group = "router"
    description = "Runs the JMH benchmarks. Pass JMH options with -PjmhArgs=\"...\"."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = "org.openjdk.jmh.Main"
    args = (providers.gradleProperty("jmhArgs").orNull ?: "").split(" ").filter { it.isNotBlank() }
}
