// GTFS zip loader, transfer generation and the snapshot cache.

dependencies {
    "api"(project(":router-core"))
}

val realZip = providers.environmentVariable("ROUTER_REAL_ZIP").orElse("")

tasks.withType<Test>().configureEach {
    // The whole NSW weekday must load inside the service's heap limit (section 5 of the plan).
    maxHeapSize = "768m"
    // RealExportTest runs only when this names an exported zip; see the README.
    inputs.property("realZip", realZip)
}

tasks.register<JavaExec>("loadTimetable") {
    group = "router"
    description = "Loads a GTFS zip and reports counts, time and memory. " +
        "Pass arguments with -PloadArgs=\"<zip> [--date yyyymmdd] [--snapshots <folder>]\"; " +
        "paths are relative to the repository root."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = "gtfseditor.router.gtfs.LoadCli"
    maxHeapSize = "768m"
    workingDir = rootProject.projectDir.parentFile.parentFile
    args = (providers.gradleProperty("loadArgs").orNull
        ?: "data/exports/check/export.zip --snapshots data/router/snapshots")
        .split(" ").filter { it.isNotBlank() }
}

tasks.register<JavaExec>("route") {
    group = "router"
    description = "Plans a journey from the command line. " +
        "Pass -ProuteArgs=\"<from> <to> <time>\" or -ProuteArgs=\"--random 2000\"; " +
        "add -Pzip=<zip> for a feed other than the editor's exported weekday."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = "gtfseditor.router.gtfs.RouteCli"
    maxHeapSize = "768m"
    workingDir = rootProject.projectDir.parentFile.parentFile
    args = listOf(providers.gradleProperty("zip").orNull ?: "data/exports/check/export.zip",
        "--snapshots", "data/router/snapshots") +
        (providers.gradleProperty("routeArgs").orNull ?: "").split(" ").filter { it.isNotBlank() }
}
