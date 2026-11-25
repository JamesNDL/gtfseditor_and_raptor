# osmium for `npm run road:data` (architecture §3.5, D18): cuts the Australia OpenStreetMap
# extract to the Opal area. Built from Debian's own osmium-tool package, as there is no official
# osmium image. No ENTRYPOINT: the command names osmium, e.g.
#   docker run --rm -v <data>/osm:/osm gtfs-editor-osmium osmium extract -b ... /osm/in.osm.pbf -o /osm/out.osm.pbf
FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends osmium-tool \
    && rm -rf /var/lib/apt/lists/*
