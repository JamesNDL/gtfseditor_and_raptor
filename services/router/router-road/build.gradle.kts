// Road routing behind a small interface (RoadRouter), done with GraphHopper (decision D14).
// Only this module depends on GraphHopper.

dependencies {
    "api"(project(":router-core"))
    "implementation"(libs.graphhopper.core)
    // GraphHopper brings Jackson 2.19; this keeps the router's own version (architecture §3.1).
    "implementation"(libs.jackson.databind)
    // So the import command shows GraphHopper's progress.
    "runtimeOnly"(libs.slf4j.simple)
}

tasks.withType<Test>().configureEach {
    maxHeapSize = "512m"
}

tasks.register<JavaExec>("roadImport") {
    group = "router"
    description = "Builds the road graph from an OpenStreetMap extract. " +
        "Pass -ProadArgs=\"<osm file> <graph folder>\"; paths are relative to the repository root."
    classpath = project.the<SourceSetContainer>()["main"].runtimeClasspath
    mainClass = "gtfseditor.router.road.RoadImport"
    // The import's peak, estimated (architecture §3.4); AA-7 measures it.
    maxHeapSize = "2g"
    workingDir = rootProject.projectDir.parentFile.parentFile
    args = (providers.gradleProperty("roadArgs").orNull
        ?: "data/osm/opal.osm.pbf data/router/road/opal")
        .split(" ").filter { it.isNotBlank() }
}
