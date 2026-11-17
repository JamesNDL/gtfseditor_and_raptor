# Build context: services/router
#   docker build -t gtfs-router services/router

FROM eclipse-temurin:25-jdk AS build
WORKDIR /src
COPY . .
# A Windows checkout may have given the wrapper script CRLF line endings; remove them.
RUN sed -i 's/\r$//' gradlew && chmod +x gradlew \
    && ./gradlew --no-daemon :router-server:installDist

FROM eclipse-temurin:25-jre
WORKDIR /app
COPY --from=build /src/router-server/build/install/router-server/ ./
# Snapshots and fetched or uploaded zips are kept in /data/router; mount a folder there to keep them.
RUN useradd --system --no-create-home router \
    && mkdir -p /data/router && chown router /data/router
USER router
ENV ROUTER_PORT=3002 \
    ROUTER_DATA=/data/router \
    JAVA_OPTS="-XX:MaxRAMPercentage=75"
VOLUME /data/router
EXPOSE 3002
ENTRYPOINT ["/app/bin/router-server"]
