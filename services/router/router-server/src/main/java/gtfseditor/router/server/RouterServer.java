package gtfseditor.router.server;

import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.JsonToken;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.core.LoadState;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import gtfseditor.router.core.TimetableStats;
import gtfseditor.router.core.TransferSettings;
import gtfseditor.router.gtfs.LoadOptions;
import gtfseditor.router.gtfs.WaterFile;
import gtfseditor.router.sim.Demand;
import gtfseditor.router.sim.DemandGenerator;
import gtfseditor.router.sim.DemandReader;
import gtfseditor.router.sim.DemandReport;
import gtfseditor.router.sim.DemandWriter;
import io.javalin.Javalin;
import io.javalin.http.Context;
import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The router's HTTP service: health, loading and unloading timetables, their metadata, and one
 * journey at a time or many, load states, and simulation runs as jobs. See section 8 of
 * docs/router-plan.md and section 5.1 of docs/simulator-plan.md. Road routing is not built.
 */
public final class RouterServer implements AutoCloseable {

    /** How long a zip may take to arrive from a URL. The editor's export takes up to five minutes. */
    private static final Duration FETCH_TIMEOUT = Duration.ofMinutes(15);

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private final Settings settings;
    private final Timetables timetables;
    private final ObjectMapper mapper = new ObjectMapper();
    private final Simulations simulations;
    private final Javalin app;

    public static void main(String[] args) {
        Settings settings;
        try {
            settings = Settings.from(System.getenv());
        } catch (IllegalArgumentException e) {
            System.err.println(e.getMessage());
            System.exit(2);
            return;
        }
        RouterServer server = new RouterServer(settings).start();
        Runtime.getRuntime().addShutdownHook(new Thread(server::close, "router-shutdown"));
        settings.preload().forEach((id, path) -> {
            try {
                server.loadFile(id, null, path, 0);
            } catch (ApiException e) {
                System.err.println("Timetable " + id + " was not loaded: " + e.getMessage());
            }
        });
    }

    public RouterServer(Settings settings) {
        this.settings = settings;
        this.timetables = new Timetables(settings);
        this.simulations = new Simulations(settings, timetables, mapper);
        this.app = Javalin.create(config -> {
            config.startup.showJavalinBanner = false;
            config.routes.get("/v1/health", this::health);
            config.routes.get("/v1/timetables", this::list);
            config.routes.get("/v1/timetables/{id}", this::metadata);
            config.routes.put("/v1/timetables/{id}", this::load);
            config.routes.delete("/v1/timetables/{id}", this::unload);
            config.routes.post("/v1/journeys", this::journey);
            config.routes.post("/v1/journeys/bulk", this::bulk);
            config.routes.get("/v1/timetables/{id}/loads", this::listLoads);
            config.routes.post("/v1/timetables/{id}/loads", this::createLoads);
            config.routes.get("/v1/timetables/{id}/loads/{name}", this::loads);
            config.routes.delete("/v1/timetables/{id}/loads/{name}", this::deleteLoads);
            config.routes.post("/v1/demand/check", this::checkDemand);
            config.routes.post("/v1/demand/generate", this::generateDemand);
            config.routes.post("/v1/simulations", this::simulate);
            config.routes.get("/v1/simulations", this::listSimulations);
            config.routes.get("/v1/simulations/{id}", this::simulation);
            config.routes.get("/v1/simulations/{id}/files/{name}", this::simulationFile);
            config.routes.delete("/v1/simulations/{id}", this::deleteSimulation);
            config.routes.exception(ApiException.class,
                    (e, ctx) -> ctx.status(e.status()).json(error(e.getMessage())));
            config.routes.exception(JsonProcessingException.class,
                    (e, ctx) -> ctx.status(400).json(error("the request is not JSON: " + e.getOriginalMessage())));
            config.routes.exception(IllegalArgumentException.class,
                    (e, ctx) -> ctx.status(400).json(error(e.getMessage())));
        });
    }

    /** Starts listening on the port in the settings; 0 means any free port. */
    public RouterServer start() {
        app.start(settings.port());
        return this;
    }

    public int port() {
        return app.port();
    }

    @Override
    public void close() {
        app.stop();
        simulations.close();
        timetables.close();
    }

    private static ObjectNode error(String message) {
        return JSON.objectNode().put("error", message);
    }

    // ---- health and metadata

    private void health(Context ctx) {
        ObjectNode body = JSON.objectNode().put("status", "up");
        ArrayNode ids = body.putArray("timetables");
        for (Timetables.View view : timetables.list()) {
            if (view.loaded() != null) {
                ids.add(view.id());
            }
        }
        body.putObject("road").put("available", false);
        ctx.json(body);
    }

    private void list(Context ctx) {
        ArrayNode all = JSON.arrayNode();
        for (Timetables.View view : timetables.list()) {
            all.add(describe(view, false));
        }
        ctx.json(JSON.objectNode().<ObjectNode>set("timetables", all));
    }

    private void metadata(Context ctx) {
        Timetables.View view = timetables.view(ctx.pathParam("id"));
        if (view == null) {
            throw new ApiException(404, "there is no timetable '" + ctx.pathParam("id") + "'");
        }
        ctx.json(describe(view, true));
    }

    private void unload(Context ctx) {
        if (!timetables.remove(ctx.pathParam("id"))) {
            throw new ApiException(404, "there is no timetable '" + ctx.pathParam("id") + "'");
        }
        ctx.status(204);
    }

    /** One timetable for the list, or with every setting and note for its own address. */
    private static ObjectNode describe(Timetables.View view, boolean full) {
        ObjectNode node = JSON.objectNode().put("id", view.id());
        Timetables.Loaded loaded = view.loaded();
        node.put("status", loaded != null ? "ready" : view.building() != null ? "building" : "failed");
        if (loaded != null) {
            Timetable t = loaded.router().timetable();
            TimetableStats s = loaded.stats();
            node.put("version", loaded.version());
            node.put("serviceDate", String.format("%04d-%02d-%02d", t.serviceDate / 10000,
                    t.serviceDate / 100 % 100, t.serviceDate % 100));
            node.put("feedVersion", t.feedVersion);
            node.set("source", source(loaded.source()));
            node.put("loadedAt", loaded.loadedAt().toString());
            node.put("loadSecs", Math.round(loaded.loadSecs() * 10) / 10.0);
            node.put("fromSnapshot", loaded.fromSnapshot());
            node.putObject("counts").put("stops", s.stops()).put("stations", s.stations()).put("routes", s.routes())
                    .put("patterns", s.patterns()).put("patternStops", s.patternStops()).put("trips", s.trips())
                    .put("stopTimes", s.stopTimes()).put("transfers", s.transfers());
            node.putObject("service").put("firstDeparture", s.firstDeparture()).put("lastArrival", s.lastArrival());
            node.putObject("memory").put("timetableBytes", s.estimatedBytes());
            if (full) {
                node.putObject("capacity").put("factor", t.capacityFactor)
                        .put("placeholderTrips", s.placeholderCapacity())
                        .put("defaultedTrips", s.defaultedCapacity());
                TransferSettings w = t.transferSettings;
                node.putObject("transferSettings").put("radiusMetres", w.radiusMetres())
                        .put("walkMetresPerSec", w.walkMetresPerSec()).put("detourFactor", w.detourFactor())
                        .put("fixedSecs", w.fixedSecs()).put("stationMinSecs", w.stationMinSecs())
                        .put("stationMaxMetres", w.stationMaxMetres()).put("maxPerStop", w.maxPerStop())
                        .put("defaultPathwaySecs", w.defaultPathwaySecs()).put("maxPathwaySecs", w.maxPathwaySecs())
                        .put("platformSecs", w.platformSecs())
                        .put("mostAtOneStop", s.mostTransfersAtAStop());
                node.putObject("water").put("lines", t.water.lineCount()).put("bridges", t.water.bridgeCount());
                ObjectNode defaults = node.putObject("journeyDefaults");
                defaults.put("maxRides", loaded.router().maxRides())
                        .put("maxWalkMetres", Router.DEFAULT_MAX_WALK_METRES)
                        .put("changeSecs", Query.DEFAULT_CHANGE_SECS);
                ArrayNode avoid = defaults.putArray("avoid");
                Router.DEFAULT_AVOID.stream().map(Mode::wireName).sorted().forEach(avoid::add);
                ArrayNode notes = node.putArray("notes");
                t.notes.forEach(notes::add);
            }
            ArrayNode loadNames = node.putArray("loads");
            loaded.loads().keySet().stream().sorted().forEach(loadNames::add);
        }
        if (view.building() != null) {
            node.putObject("building").put("version", view.building().version())
                    .put("startedAt", view.building().startedAt().toString())
                    .set("source", source(view.building().source()));
        }
        if (view.failure() != null) {
            node.putObject("lastFailure").put("version", view.failure().version())
                    .put("at", view.failure().at().toString()).put("message", view.failure().message())
                    .set("source", source(view.failure().source()));
        }
        return node;
    }

    private static ObjectNode source(Timetables.Source source) {
        ObjectNode node = JSON.objectNode().put("kind", source.kind());
        if (!source.value().isEmpty()) {
            node.put(source.kind(), source.value());
        }
        return node;
    }

    // ---- loading

    /**
     * {@code PUT /v1/timetables/{id}}. Either JSON naming where the zip is,
     * {@code {"source": {"path": ..}}} or {@code {"source": {"url": ..}}}, with an optional
     * {@code version}, {@code serviceDate} and {@code water} (a water file, named the same way);
     * or the zip itself as the body, with the first two in the query string. Answers at once; the
     * build goes on behind.
     */
    private void load(Context ctx) throws IOException {
        String id = ctx.pathParam("id");
        if (!Timetables.isId(id)) {
            throw ApiException.bad("a timetable id is 1 to 64 letters, digits, dots, dashes or underscores");
        }
        String type = ctx.contentType() == null ? "" : ctx.contentType().toLowerCase(Locale.ROOT);
        Timetables.View view;
        if (type.startsWith("application/json")) {
            JsonNode body = mapper.readTree(ctx.body());
            JsonNode source = body.path("source");
            String version = body.hasNonNull("version") ? body.get("version").asText() : null;
            JsonNode date = body.path("serviceDate");
            if (!date.isMissingNode() && !date.isNull() && !date.isIntegralNumber()) {
                throw ApiException.bad("serviceDate must be a number such as 20261117");
            }
            Timetables.OptionsStep options = waterStep(body.path("water"), options(date.asInt(0)));
            if (source.hasNonNull("path")) {
                view = loadFile(id, version, path(source.get("path").asText()), options);
            } else if (source.hasNonNull("url")) {
                view = loadUrl(id, version, source.get("url").asText(), options);
            } else {
                throw ApiException.bad("name the zip as {\"source\": {\"path\": ..}} or {\"source\": {\"url\": ..}},"
                        + " or send the zip itself with Content-Type: application/zip");
            }
        } else if (type.startsWith("application/zip") || type.startsWith("application/octet-stream")) {
            view = loadUpload(id, ctx.queryParam("version"), ctx.req().getInputStream(),
                    serviceDate(ctx.queryParam("serviceDate")));
        } else {
            throw new ApiException(415, "send JSON naming the zip, or the zip itself with Content-Type: application/zip");
        }
        ObjectNode answer = describe(view, true);
        if (view.loaded() != null && !view.loaded().loads().isEmpty()) {
            answer.put("note", "The load states of this timetable belong to the version loaded now."
                    + " They will be gone when the new one is ready.");
        }
        ctx.status(202).json(answer);
    }

    private static Path path(String text) {
        try {
            return Path.of(text);
        } catch (InvalidPathException e) {
            throw ApiException.bad("'" + text + "' is not a file path");
        }
    }

    private static int serviceDate(String text) {
        if (text == null || text.isBlank()) {
            return 0;
        }
        try {
            return Integer.parseInt(text.strip());
        } catch (NumberFormatException e) {
            throw ApiException.bad("serviceDate must be a number such as 20261117");
        }
    }

    private static LoadOptions options(int serviceDate) {
        if (serviceDate < 0) {
            throw ApiException.bad("serviceDate must be a number such as 20261117");
        }
        return LoadOptions.defaults().withServiceDate(serviceDate);
    }

    /**
     * Where to read the water file from when the build starts: {@code {"path": ..}} or
     * {@code {"url": ..}}. Left out, no water is known and every straight walk is offered.
     */
    private Timetables.OptionsStep waterStep(JsonNode water, LoadOptions options) {
        if (water.isMissingNode() || water.isNull()) {
            return () -> options;
        }
        if (water.hasNonNull("path")) {
            Path file = path(water.get("path").asText()).toAbsolutePath().normalize();
            if (!Files.isRegularFile(file)) {
                throw ApiException.bad("there is no file " + file);
            }
            return () -> options.withWater(WaterFile.read(file));
        }
        if (!water.hasNonNull("url")) {
            throw ApiException.bad("name the water file as {\"water\": {\"path\": ..}} or {\"water\": {\"url\": ..}}");
        }
        URI address = address(water.get("url").asText());
        return () -> {
            try (HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL)
                    .connectTimeout(Duration.ofSeconds(20)).build()) {
                HttpResponse<InputStream> response;
                try {
                    response = client.send(HttpRequest.newBuilder(address).timeout(FETCH_TIMEOUT).build(),
                            HttpResponse.BodyHandlers.ofInputStream());
                } catch (IOException e) {
                    throw new IOException("could not fetch " + address + ": "
                            + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()), e);
                }
                try (InputStream in = response.body()) {
                    if (response.statusCode() != 200) {
                        throw new IOException("fetching " + address + " answered " + response.statusCode());
                    }
                    return options.withWater(WaterFile.read(in, "the water file"));
                }
            }
        };
    }

    private static URI address(String url) {
        URI address;
        try {
            address = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw ApiException.bad("'" + url + "' is not a URL");
        }
        if (address.getHost() == null || !("http".equals(address.getScheme()) || "https".equals(address.getScheme()))) {
            throw ApiException.bad("'" + url + "' is not an http or https URL");
        }
        return address;
    }

    /** Loads a zip that is already on this machine, where it lies. */
    Timetables.View loadFile(String id, String version, Path zip, int serviceDate) {
        LoadOptions options = options(serviceDate);
        return loadFile(id, version, zip, () -> options);
    }

    Timetables.View loadFile(String id, String version, Path zip, Timetables.OptionsStep options) {
        Path file = zip.toAbsolutePath().normalize();
        if (!Files.isRegularFile(file)) {
            throw ApiException.bad("there is no file " + file);
        }
        Timetables.View view = timetables.begin(id, version, new Timetables.Source("path", file.toString()));
        timetables.build(id, options, () -> file);
        return view;
    }

    private Timetables.View loadUrl(String id, String version, String url, Timetables.OptionsStep options) {
        URI address = address(url);
        Timetables.View view = timetables.begin(id, version, new Timetables.Source("url", url));
        timetables.build(id, options, () -> fetch(address, id));
        return view;
    }

    private Timetables.View loadUpload(String id, String version, InputStream body, int serviceDate) {
        LoadOptions options = options(serviceDate);
        Timetables.View view = timetables.begin(id, version, new Timetables.Source("upload", ""));
        Path zip;
        try {
            Path part = partFile(id);
            try {
                Files.copy(body, part, StandardCopyOption.REPLACE_EXISTING);
                zip = keep(part, id);
            } finally {
                Files.deleteIfExists(part);
            }
        } catch (IOException e) {
            timetables.fail(id, "the upload did not arrive whole: " + e.getMessage());
            throw ApiException.bad("the upload did not arrive whole: " + e.getMessage());
        }
        timetables.build(id, options, () -> zip);
        return view;
    }

    /** Fetches a zip into the data folder. Runs on the build thread. */
    private Path fetch(URI address, String id) throws IOException, InterruptedException {
        Path part = partFile(id);
        try (HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(20)).build()) {
            HttpResponse<Path> response;
            try {
                response = client.send(HttpRequest.newBuilder(address).timeout(FETCH_TIMEOUT).build(),
                        HttpResponse.BodyHandlers.ofFile(part));
            } catch (IOException e) {
                throw new IOException("could not fetch " + address + ": "
                        + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()), e);
            }
            if (response.statusCode() != 200) {
                throw new IOException("fetching " + address + " answered " + response.statusCode());
            }
            return keep(part, id);
        } finally {
            Files.deleteIfExists(part);
        }
    }

    private Path partFile(String id) throws IOException {
        Files.createDirectories(settings.zips());
        return settings.zips().resolve(id + ".zip.part");
    }

    /** Moves a zip that has arrived whole to its lasting name, replacing the one before. */
    private Path keep(Path part, String id) throws IOException {
        Path zip = settings.zips().resolve(id + ".zip");
        Files.move(part, zip, StandardCopyOption.REPLACE_EXISTING);
        return zip;
    }

    // ---- journeys

    private void journey(Context ctx) throws IOException {
        JsonNode body = mapper.readTree(ctx.body());
        String timetable = body != null && body.hasNonNull("timetable") ? body.get("timetable").asText() : null;
        try (Timetables.Lease lease = timetables.lease(timetable)) {
            ctx.json(JourneyApi.single(lease.loaded(), body));
        }
    }

    /**
     * {@code POST /v1/journeys/bulk}: the settings once and the journeys as a list. The body is read
     * a journey at a time, so a long list does not have to fit in memory as text; the answer is
     * written a line at a time as journeys are settled.
     */
    private void bulk(Context ctx) throws IOException {
        ObjectNode shared = JSON.objectNode();
        List<JourneyApi.Item> items = new ArrayList<>();
        try (JsonParser parser = mapper.getFactory().createParser(ctx.req().getInputStream())) {
            if (parser.nextToken() != JsonToken.START_OBJECT) {
                throw ApiException.bad("the request must be a JSON object");
            }
            while (parser.nextToken() == JsonToken.FIELD_NAME) {
                String name = parser.currentName();
                parser.nextToken();
                if (!name.equals("queries")) {
                    shared.set(name, mapper.readTree(parser));
                    continue;
                }
                if (parser.currentToken() != JsonToken.START_ARRAY) {
                    throw ApiException.bad("queries must be a list");
                }
                while (parser.nextToken() != JsonToken.END_ARRAY) {
                    if (parser.currentToken() == null) {
                        throw ApiException.bad("the request ends in the middle of the list of queries");
                    }
                    if (items.size() == settings.bulkLimit()) {
                        throw new ApiException(413, "a bulk request may hold at most " + settings.bulkLimit()
                                + " queries; send the rest in another");
                    }
                    items.add(JourneyApi.Item.readOrError(mapper.readTree(parser)));
                }
            }
        }
        JourneyApi.Options options = JourneyApi.Options.read(shared, true);
        try (Timetables.Lease lease = timetables.lease(options.timetable())) {
            boolean[] begun = new boolean[1];
            try {
                JourneyApi.bulk(lease.loaded(), options, items, mapper, () -> {
                    ctx.status(200).contentType("application/x-ndjson");
                    begun[0] = true;
                }, ctx.res().getOutputStream());
            } catch (IOException e) {
                // The caller went away part way through; there is nobody to tell.
            } catch (RuntimeException e) {
                if (!begun[0]) {
                    throw e;
                }
                // Too late for an error status: say so on a line of its own, in place of the totals.
                ctx.res().getOutputStream().write(mapper.writeValueAsBytes(
                        error(e.getMessage() == null ? e.toString() : e.getMessage())));
                ctx.res().getOutputStream().write(10);
            }
        }
    }

    // ---- demand files

    /**
     * {@code POST /v1/demand/check}: a demand CSV as the body, gzipped or not. Answers what the
     * reader made of it: rows read and refused with the reasons, figures about the rest, and how
     * many rows name each stop id, so that the caller can look the ids up.
     */
    private void checkDemand(Context ctx) throws IOException {
        String type = ctx.contentType() == null ? "" : ctx.contentType().toLowerCase(Locale.ROOT);
        String encoding = ctx.header("Content-Encoding") == null ? "" : ctx.header("Content-Encoding");
        InputStream body = ctx.req().getInputStream();
        if (type.startsWith("application/gzip") || encoding.equalsIgnoreCase("gzip")) {
            body = new java.util.zip.GZIPInputStream(body, 1 << 16);
        }
        DemandReader.Read read = DemandReader.read(new java.io.InputStreamReader(body,
                java.nio.charset.StandardCharsets.UTF_8));
        Demand demand = read.demand();
        DemandReport.Figures figures = DemandReport.figures(demand);
        ObjectNode answer = JSON.objectNode().put("rowsRead", read.report().rowsRead())
                .put("rowsRefused", read.report().rowsRefused());
        ObjectNode refused = answer.putObject("refused");
        read.report().refused().forEach(refused::put);
        ArrayNode examples = answer.putArray("examples");
        read.report().examples().forEach(examples::add);
        answer.put("rows", figures.rows()).put("people", figures.people()).put("users", figures.users())
                .put("earliest", figures.earliest()).put("latest", figures.latest())
                .put("busiestHour", figures.busiestHour()).put("busiestHourPeople", figures.busiestHourPeople())
                .put("rowsBefore4am", figures.rowsBefore4am()).put("madeUpIds", figures.madeUpIds());
        ArrayNode warnings = answer.putArray("warnings");
        figures.warnings().forEach(warnings::add);
        int[] rowsAt = new int[demand.placeCount()];
        int positions = 0;
        for (int row = 0; row < demand.size(); row++) {
            rowsAt[demand.origin[row]]++;
            rowsAt[demand.destination[row]]++;
        }
        java.util.Map<String, Integer> byStop = new java.util.TreeMap<>();
        for (int place = 0; place < rowsAt.length; place++) {
            if (!Double.isNaN(demand.placeLat[place])) {
                positions += rowsAt[place]; // this end has a position of its own, whatever its stop id
            } else {
                byStop.merge(demand.placeStop[place], rowsAt[place], Integer::sum);
            }
        }
        answer.put("endsWithOwnPosition", positions);
        ObjectNode stops = answer.putObject("stops");
        byStop.forEach(stops::put);
        ctx.json(answer);
    }

    /**
     * {@code POST /v1/demand/generate}: makes a demand set up on a loaded timetable and answers it
     * as a gzipped CSV. {@code journeys}, {@code seed}, {@code area}, {@code withinKm},
     * {@code focus} and {@code people} are as for the command line.
     */
    private void generateDemand(Context ctx) throws IOException {
        JsonNode body = mapper.readTree(ctx.body());
        if (body == null || !body.isObject()) {
            throw ApiException.bad("the request must be a JSON object");
        }
        int journeys = body.path("journeys").asInt(100_000);
        if (journeys < 1 || journeys > 5_000_000) {
            throw ApiException.bad("journeys is 1 to 5,000,000");
        }
        gtfseditor.router.sim.Area area = body.has("area") ? Simulations.area(body.get("area"))
                : gtfseditor.router.sim.Area.OPAL;
        Demand demand;
        try (Timetables.Lease lease = timetables.lease(body.hasNonNull("timetable") ? body.get("timetable").asText() : null)) {
            demand = DemandGenerator.generate(lease.loaded().router(), area, journeys,
                    body.path("seed").asLong(1), body.path("withinKm").asDouble(DemandGenerator.DEFAULT_WITHIN_KM),
                    body.path("focus").asDouble(1.0), body.path("people").asInt(1), settings.threads());
        }
        ctx.status(200).contentType("application/gzip");
        try (java.io.Writer out = new java.io.OutputStreamWriter(new java.util.zip.GZIPOutputStream(
                ctx.res().getOutputStream(), 1 << 16), java.nio.charset.StandardCharsets.UTF_8)) {
            DemandWriter.write(demand, out);
        }
    }

    // ---- simulation runs

    private void simulate(Context ctx) throws IOException {
        ctx.status(202).json(simulations.submit(mapper.readTree(ctx.body())));
    }

    private void listSimulations(Context ctx) {
        ctx.json(JSON.objectNode().<ObjectNode>set("simulations", simulations.list()));
    }

    private void simulation(Context ctx) {
        ctx.json(simulations.view(ctx.pathParam("id")));
    }

    /** One result file, as it lies on disk: the summary as JSON, the rest as gzipped CSV. */
    private void simulationFile(Context ctx) throws IOException {
        Path file = simulations.file(ctx.pathParam("id"), ctx.pathParam("name"));
        ctx.status(200).contentType(file.getFileName().toString().endsWith(".json")
                ? "application/json" : "application/gzip");
        ctx.header("Content-Length", Long.toString(Files.size(file)));
        try (InputStream in = Files.newInputStream(file)) {
            in.transferTo(ctx.res().getOutputStream());
        }
    }

    /** Stops a run that is waiting or running (202, with the run), or discards one that has ended (204). */
    private void deleteSimulation(Context ctx) {
        ObjectNode stopped = simulations.delete(ctx.pathParam("id"), "true".equals(ctx.queryParam("force")));
        if (stopped == null) {
            ctx.status(204);
        } else {
            ctx.status(202).json(stopped);
        }
    }

    // ---- load states

    /** The most load states one timetable may hold. Each is as many numbers as there are stop times. */
    private static final int MAX_LOADS = 8;

    private Timetables.Loads loadsOf(Timetables.Loaded loaded, String name) {
        Timetables.Loads loads = loaded.loads().get(name);
        if (loads == null) {
            throw new ApiException(404, "timetable '" + loaded.id() + "' has no load state '" + name + "'");
        }
        return loads;
    }

    private static ObjectNode describe(Timetables.Loads loads) {
        LoadState.Summary s = loads.state().summary();
        return JSON.objectNode().put("name", loads.name()).put("createdAt", loads.createdAt().toString())
                .put("passengers", s.passengers()).put("tripsWithLoad", s.tripsWithLoad())
                .put("fullTrips", s.fullTrips()).put("loadedCalls", s.loadedCalls()).put("fullCalls", s.fullCalls())
                .put("peakFactor", Math.round(s.peakFactor() * 1000) / 1000.0);
    }

    private void listLoads(Context ctx) {
        try (Timetables.Lease lease = timetables.lease(ctx.pathParam("id"))) {
            ArrayNode all = JSON.arrayNode();
            lease.loaded().loads().values().stream()
                    .sorted(java.util.Comparator.comparing(Timetables.Loads::name))
                    .forEach(loads -> all.add(describe(loads)));
            ctx.json(JSON.objectNode().<ObjectNode>set("loads", all));
        }
    }

    /**
     * {@code POST /v1/timetables/{id}/loads}. Either JSON, {@code {"name": ..}}, for a load state
     * with nobody aboard anything; or a CSV of loads as the body, with the name in the query string.
     * The CSV has the columns {@code trip_id}, {@code position} and {@code load}.
     */
    private void createLoads(Context ctx) throws IOException {
        String type = ctx.contentType() == null ? "" : ctx.contentType().toLowerCase(Locale.ROOT);
        try (Timetables.Lease lease = timetables.lease(ctx.pathParam("id"))) {
            Timetables.Loaded loaded = lease.loaded();
            LoadState state;
            String name;
            if (type.startsWith("application/json")) {
                JsonNode body = mapper.readTree(ctx.body());
                name = body != null && body.hasNonNull("name") ? body.get("name").asText() : null;
                state = LoadState.empty(loaded.router().timetable());
            } else if (type.startsWith("text/csv")) {
                name = ctx.queryParam("name");
                state = LoadsCsv.read(loaded.router().timetable(), ctx.req().getInputStream());
            } else {
                throw new ApiException(415, "send JSON with a name, or a CSV of loads with Content-Type: text/csv");
            }
            if (name == null || !Timetables.isId(name)) {
                throw ApiException.bad("a load state needs a name of 1 to 64 letters, digits, dots, dashes or underscores");
            }
            Timetables.Loads loads = new Timetables.Loads(name, state, Instant.now().truncatedTo(ChronoUnit.SECONDS),
                    new ReentrantLock());
            synchronized (loaded.loads()) {
                if (loaded.loads().containsKey(name)) {
                    throw new ApiException(409, "timetable '" + loaded.id() + "' already has a load state '" + name
                            + "'; delete it first");
                }
                if (loaded.loads().size() >= MAX_LOADS) {
                    throw new ApiException(409, "a timetable may hold " + MAX_LOADS + " load states; delete one first");
                }
                loaded.loads().put(name, loads);
            }
            ctx.status(201).json(describe(loads));
        }
    }

    /** {@code GET /v1/timetables/{id}/loads/{name}}: a summary, or with {@code ?format=csv} every load above 0. */
    private void loads(Context ctx) throws IOException {
        try (Timetables.Lease lease = timetables.lease(ctx.pathParam("id"))) {
            Timetables.Loads loads = loadsOf(lease.loaded(), ctx.pathParam("name"));
            if ("csv".equals(ctx.queryParam("format"))) {
                ctx.status(200).contentType("text/csv; charset=utf-8");
                LoadsCsv.write(loads.state(), ctx.res().getOutputStream());
            } else {
                ctx.json(describe(loads));
            }
        }
    }

    private void deleteLoads(Context ctx) {
        try (Timetables.Lease lease = timetables.lease(ctx.pathParam("id"))) {
            Timetables.Loads loads = loadsOf(lease.loaded(), ctx.pathParam("name"));
            if (!loads.assigning().tryLock()) {
                throw new ApiException(409, "a request is adding passengers to load state '" + loads.name()
                        + "'; delete it when that has finished");
            }
            try {
                lease.loaded().loads().remove(loads.name());
            } finally {
                loads.assigning().unlock();
            }
            ctx.status(204);
        }
    }
}
