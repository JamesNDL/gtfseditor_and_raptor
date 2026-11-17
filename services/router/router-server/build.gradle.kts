// The HTTP service: a thin layer over the library modules.

plugins {
    application
}

dependencies {
    "implementation"(project(":router-core"))
    "implementation"(project(":router-gtfs"))
    "implementation"(project(":router-road"))
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
    maxHeapSize = "768m"
}

tasks.withType<Test>().configureEach {
    maxHeapSize = "512m"
}
