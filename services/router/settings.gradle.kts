rootProject.name = "router"

dependencyResolutionManagement {
    repositoriesMode = RepositoriesMode.FAIL_ON_PROJECT_REPOS
    repositories {
        mavenCentral()
    }
}

include(
    "router-core",
    "router-gtfs",
    "router-road",
    "router-server",
    "router-bench",
)
