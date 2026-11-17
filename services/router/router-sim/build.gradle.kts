// The passenger simulator: demand files, planning, the replay in time order and the result
// files. See docs/simulator-plan.md. The library needs only router-core; router-gtfs is here for
// the command line, which has to load a zip.

dependencies {
    "api"(project(":router-core"))
    "implementation"(project(":router-gtfs"))
}

val heap = providers.gradleProperty("simHeap").orNull ?: "768m"
val repositoryRoot = rootProject.projectDir.parentFile.parentFile

fun words(property: String) =
    (providers.gradleProperty(property).orNull ?: "").split(" ").filter { it.isNotBlank() }

tasks.withType<Test>().configureEach {
    maxHeapSize = "512m"
}

tasks.register<JavaExec>("demand") {
    group = "router"
    description = "Makes up or checks a demand file. Pass -PsimArgs=\"generate <zip> --out <file> " +
        "[--journeys 100000] [--seed 1] [--area opal]\" or -PsimArgs=\"check <file> [--zip <zip>]\"."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = "gtfseditor.router.sim.SimCli"
    maxHeapSize = heap
    workingDir = repositoryRoot
    args = listOf("demand") + words("simArgs")
}

tasks.register<JavaExec>("simulate") {
    group = "router"
    description = "Runs a simulation. Pass -PsimArgs=\"<zip> --demand <file> --out <folder>\" for a " +
        "BAU run, \"<zip> --bau <folder> --out <folder>\" for a scenario run, or " +
        "\"<zip> --from-plans <folder>\" to add capacity to a run. -PsimHeap=1500m raises the heap."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = "gtfseditor.router.sim.SimCli"
    maxHeapSize = heap
    workingDir = repositoryRoot
    args = listOf("run") + words("simArgs")
}
