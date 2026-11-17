// Road routing behind a small interface. Empty until phase 6; GraphHopper is deliberately
// not a dependency yet.

dependencies {
    "api"(project(":router-core"))
}

tasks.register("roadImport") {
    group = "router"
    description = "Builds the road graph from an OpenStreetMap extract (phase 6, not built yet)."
    doLast {
        throw GradleException("roadImport is not built yet: road routing is phase 6 of docs/router-plan.md.")
    }
}
