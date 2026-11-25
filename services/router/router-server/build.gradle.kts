// The HTTP service: a thin layer over the library modules.

plugins {
    application
}

dependencies {
    "implementation"(project(":router-core"))
    "implementation"(project(":router-gtfs"))
    "implementation"(project(":router-road"))
    "implementation"(project(":router-sim"))
    "implementation"(libs.javalin)
    "implementation"(libs.jackson.databind)
    "runtimeOnly"(libs.slf4j.simple)
}

application {
    mainClass = "gtfseditor.router.server.RouterServer"
    applicationName = "router-server"
}

tasks.named<JavaExec>("run") {
    // Run from the repository root, so that data/router and data/exports are found, and inside
    // the heap limit of section 5 of the plan.
    workingDir = rootProject.projectDir.parentFile.parentFile
    // 1 GB with road routing on (architecture §3.4, D15); the road graph itself is memory-mapped.
    maxHeapSize = "1g"
}

// The road-only router (A5, D15): the same service with roads and health only, on port 3003.
tasks.register<JavaExec>("runRoad") {
    group = "application"
    description = "Runs the router with road routing only, on port 3003."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = application.mainClass
    workingDir = rootProject.projectDir.parentFile.parentFile
    environment("ROUTER_ROAD", "only")
    environment("ROUTER_PORT", "3003")
    maxHeapSize = "512m"
}

tasks.withType<Test>().configureEach {
    maxHeapSize = "512m"
}

// The road tests use router-road's hand-made map (mini-roads.osm) rather than a copy of it.
the<SourceSetContainer>()["test"].resources.srcDir(project(":router-road").file("src/test/resources"))
