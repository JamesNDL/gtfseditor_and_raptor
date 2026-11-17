package gtfseditor.router.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.core.Timetable;
import gtfseditor.router.sim.Area;
import gtfseditor.router.sim.DemandReader;
import gtfseditor.router.sim.SimRun;
import gtfseditor.router.sim.SimSettings;
import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.InvalidPathException;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Simulation runs as jobs: submit one, follow it, collect its files, stop or discard it. See
 * section 5.1 of docs/simulator-plan.md.
 *
 * <p>One run at a time; a second waits its turn. A run takes hold of its timetable when it is
 * submitted and keeps it to the end, so a reload part-way through does not change it.
 *
 * <p>Each run's files are in {@code <data>/sim/<run id>/}. A finished run found there when the
 * service starts is listed again, so runs outlive a restart: a scenario run needs its BAU run to
 * still be there. A run that failed or was stopped leaves no files, and is forgotten at a restart.
 */
final class Simulations implements AutoCloseable {

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;
    private static final String JOB_FILE = "job.json";
    private static final Duration FETCH_TIMEOUT = Duration.ofMinutes(15);

    /** The settings each kind of run may be given. The rest come from the run it is made from. */
    private static final Set<String> FOR_ANY = Set.of("fullAt", "maxLeftBehind");
    private static final Set<String> FOR_BAU = Set.of("capacity", "walkMetres", "changePenaltySecs", "schoolBuses",
            "shareOneIn", "area");
    private static final Set<String> FOR_SCENARIO = Set.of("capacity", "switchThresholdSecs", "giveUpSecs");

    private enum State { QUEUED, RUNNING, DONE, FAILED, STOPPED }

    /** One run. The fields that change are guarded by the job itself. */
    private static final class Job {
        final String id;
        final Path folder;
        String name;
        String kind;          // bau, scenario or capacity
        String timetable = "";
        String version = "";
        State state;
        String stage = "";
        long done;
        long total;
        Instant submittedAt;
        Instant startedAt;
        Instant finishedAt;
        String error;
        JsonNode summary;
        boolean stopAsked;
        Timetables.Lease lease;
        Future<?> work;

        Job(String id, Path folder) {
            this.id = id;
            this.folder = folder;
        }

        synchronized void release() {
            if (lease != null) {
                lease.close();
                lease = null;
            }
        }
    }

    private final Settings settings;
    private final Timetables timetables;
    private final ObjectMapper mapper;
    private final Map<String, Job> jobs = new LinkedHashMap<>();
    private final ExecutorService runner = Executors.newSingleThreadExecutor(work -> {
        Thread thread = new Thread(work, "router-simulation");
        thread.setDaemon(true);
        return thread;
    });
    private final AtomicInteger made = new AtomicInteger();

    Simulations(Settings settings, Timetables timetables, ObjectMapper mapper) {
        this.settings = settings;
        this.timetables = timetables;
        this.mapper = mapper;
        findFinishedRuns();
    }

    /** Lists again the runs that finished before the service last stopped. */
    private void findFinishedRuns() {
        if (!Files.isDirectory(settings.sims())) {
            return;
        }
        List<Path> folders;
        try (var files = Files.list(settings.sims())) {
            folders = files.filter(Files::isDirectory).sorted().toList();
        } catch (IOException e) {
            System.err.println("Could not look for finished simulation runs: " + e.getMessage());
            return;
        }
        for (Path folder : folders) {
            String id = folder.getFileName().toString();
            if (!Timetables.isId(id) || !SimRun.isRun(folder)) {
                continue;
            }
            try {
                Job job = new Job(id, folder);
                Properties properties = SimRun.properties(folder);
                job.kind = properties.getProperty("plans") != null ? "capacity" : properties.getProperty("kind");
                job.name = properties.getProperty("name", id);
                job.state = State.DONE;
                job.summary = mapper.readTree(Files.readAllBytes(folder.resolve("summary.json")));
                if (Files.isRegularFile(folder.resolve(JOB_FILE))) {
                    JsonNode saved = mapper.readTree(Files.readAllBytes(folder.resolve(JOB_FILE)));
                    job.timetable = saved.path("timetable").asText("");
                    job.version = saved.path("timetableVersion").asText("");
                    job.submittedAt = instant(saved.path("submittedAt"));
                    job.startedAt = instant(saved.path("startedAt"));
                    job.finishedAt = instant(saved.path("finishedAt"));
                }
                jobs.put(id, job);
            } catch (IOException | RuntimeException e) {
                System.err.println("Simulation run " + id + " could not be read and is not listed: " + e.getMessage());
            }
        }
    }

    private static Instant instant(JsonNode node) {
        return node.isTextual() ? Instant.parse(node.asText()) : null;
    }

    // ---- submitting

    /**
     * Queues a run. The request names a timetable and one of three things:
     *
     * <ul>
     *   <li>{@code "demand": {"path": ..}} or {@code {"url": ..}}: a BAU run of that demand file;
     *   <li>{@code "bau": runId}: a scenario run measured against that BAU run;
     *   <li>{@code "fromPlans": runId}: that run's kept plans, put on the vehicles with capacity on.
     * </ul>
     *
     * with optional {@code id}, {@code name} and {@code settings}.
     */
    ObjectNode submit(JsonNode body) {
        if (body == null || !body.isObject()) {
            throw ApiException.bad("the request must be a JSON object");
        }
        JsonNode demand = body.path("demand");
        String bau = text(body, "bau");
        String fromPlans = text(body, "fromPlans");
        int ways = (demand.isObject() ? 1 : 0) + (bau != null ? 1 : 0) + (fromPlans != null ? 1 : 0);
        if (ways != 1) {
            throw ApiException.bad("say what to run with exactly one of: \"demand\": {\"path\": ..} or {\"url\": ..} for"
                    + " a BAU run, \"bau\": a run id for a scenario run against it, or \"fromPlans\": a run id to"
                    + " add capacity to");
        }
        String kind = demand.isObject() ? "bau" : bau != null ? "scenario" : "capacity";
        SimSettings simSettings = settings(body.path("settings"), kind);
        Path demandFile = null;
        URI demandUrl = null;
        if (demand.isObject()) {
            if (demand.hasNonNull("path")) {
                try {
                    demandFile = Path.of(demand.get("path").asText()).toAbsolutePath().normalize();
                } catch (InvalidPathException e) {
                    throw ApiException.bad("'" + demand.get("path").asText() + "' is not a file path");
                }
                if (!Files.isRegularFile(demandFile)) {
                    throw ApiException.bad("there is no file " + demandFile);
                }
            } else if (demand.hasNonNull("url")) {
                demandUrl = url(demand.get("url").asText());
            } else {
                throw ApiException.bad("name the demand file as {\"path\": ..} or {\"url\": ..}");
            }
        }
        String wantedId = text(body, "id");
        if (wantedId != null && !Timetables.isId(wantedId)) {
            throw ApiException.bad("a run id is 1 to 64 letters, digits, dots, dashes or underscores");
        }
        String wantedName = text(body, "name");

        Job job;
        Path source;
        synchronized (this) {
            source = bau != null ? finished(bau, "bau") : fromPlans != null ? finished(fromPlans, "fromPlans") : null;
            if (bau != null && !"bau".equals(jobs.get(bau).kind)) {
                throw ApiException.bad("run '" + bau + "' is not a BAU run; a scenario run is made against one");
            }
            String id = wantedId != null ? wantedId : newId();
            if (jobs.containsKey(id)) {
                throw new ApiException(409, "there is already a run '" + id + "'; discard it first or use another id");
            }
            // Take hold of the timetable now: the run is of the version loaded as it was asked for.
            Timetables.Lease lease = timetables.lease(text(body, "timetable"));
            job = new Job(id, settings.sims().resolve(id));
            job.kind = kind;
            job.name = wantedName != null ? wantedName
                    : kind.equals("bau") ? "BAU" + (simSettings.area == null ? ", whole network"
                            : " bounded " + simSettings.area.text())
                    : kind.equals("scenario") ? lease.loaded().id() + " against " + jobs.get(bau).name
                    : jobs.get(fromPlans).name + " with capacity";
            job.timetable = lease.loaded().id();
            job.version = lease.loaded().version();
            job.state = State.QUEUED;
            job.submittedAt = now();
            job.lease = lease;
            jobs.put(id, job);
        }
        Path file = demandFile;
        URI address = demandUrl;
        Path from = source;
        synchronized (job) {
            job.work = runner.submit(() -> run(job, simSettings, file, address, from));
        }
        return describe(job, true);
    }

    private static String text(JsonNode body, String name) {
        JsonNode value = body.path(name);
        if (value.isMissingNode() || value.isNull()) {
            return null;
        }
        if (!value.isTextual() || value.asText().isBlank()) {
            throw ApiException.bad(name + " must be text");
        }
        return value.asText().strip();
    }

    private static URI url(String text) {
        URI address;
        try {
            address = URI.create(text);
        } catch (IllegalArgumentException e) {
            throw ApiException.bad("'" + text + "' is not a URL");
        }
        if (address.getHost() == null || !("http".equals(address.getScheme()) || "https".equals(address.getScheme()))) {
            throw ApiException.bad("'" + text + "' is not an http or https URL");
        }
        return address;
    }

    /** The folder of a finished run, for another to be made from. Called holding the lock. */
    private Path finished(String id, String what) {
        Job job = jobs.get(id);
        if (job == null) {
            throw new ApiException(404, what + ": there is no run '" + id + "'");
        }
        synchronized (job) {
            if (job.state != State.DONE) {
                throw new ApiException(409, what + ": run '" + id + "' is " + name(job.state) + ", not finished");
            }
        }
        return job.folder;
    }

    private String newId() {
        String stamp = now().toString().replace("-", "").replace(":", "").replace("T", "-").replace("Z", "");
        String id;
        do {
            id = "run-" + stamp + "-" + made.incrementAndGet();
        } while (jobs.containsKey(id));
        return id;
    }

    private static Instant now() {
        return Instant.now().truncatedTo(ChronoUnit.SECONDS);
    }

    /** Reads the settings a request gives, refusing any that this kind of run does not choose. */
    private SimSettings settings(JsonNode given, String kind) {
        SimSettings s = new SimSettings();
        s.threads = settings.threads();
        if (given.isMissingNode() || given.isNull()) {
            return s;
        }
        if (!given.isObject()) {
            throw ApiException.bad("settings must be an object");
        }
        Set<String> allowed = kind.equals("bau") ? FOR_BAU : kind.equals("scenario") ? FOR_SCENARIO : Set.of();
        for (Iterator<String> names = given.fieldNames(); names.hasNext();) {
            String name = names.next();
            JsonNode value = given.get(name);
            if (!allowed.contains(name) && !FOR_ANY.contains(name)) {
                boolean known = FOR_BAU.contains(name) || FOR_SCENARIO.contains(name);
                throw ApiException.bad(!known ? "there is no setting '" + name + "'"
                        : kind.equals("capacity") ? "'" + name + "' cannot be set when adding capacity to a run:"
                                + " it is that run's"
                        : kind.equals("scenario") ? "a scenario run takes '" + name + "' from its BAU run"
                        : "'" + name + "' is a setting of a scenario run, not of a BAU run");
            }
            switch (name) {
                case "capacity" -> s.capacity = flag(name, value);
                case "schoolBuses" -> s.schoolBuses = flag(name, value);
                case "walkMetres" -> s.walkMetres = number(name, value);
                case "fullAt" -> s.fullAt = number(name, value);
                case "changePenaltySecs" -> s.changePenaltySecs = whole(name, value);
                case "switchThresholdSecs" -> s.switchThresholdSecs = whole(name, value);
                case "shareOneIn" -> s.shareOneIn = whole(name, value);
                case "maxLeftBehind" -> s.maxLeftBehind = whole(name, value);
                case "giveUpSecs" -> s.giveUpSecs = value.isNull() ? -1 : whole(name, value);
                case "area" -> s.area = area(value);
                default -> throw new IllegalStateException(name);
            }
        }
        s.check(); // an IllegalArgumentException here is answered as a bad request
        return s;
    }

    private static boolean flag(String name, JsonNode value) {
        if (!value.isBoolean()) {
            throw ApiException.bad(name + " must be true or false");
        }
        return value.asBoolean();
    }

    private static double number(String name, JsonNode value) {
        if (!value.isNumber()) {
            throw ApiException.bad(name + " must be a number");
        }
        return value.asDouble();
    }

    private static int whole(String name, JsonNode value) {
        if (!value.isIntegralNumber() || !value.canConvertToInt()) {
            throw ApiException.bad(name + " must be a whole number");
        }
        return value.asInt();
    }

    /** An area by name, {@code "all"}, or a box of {@code south}, {@code west}, {@code north} and {@code east}. */
    private static Area area(JsonNode value) {
        if (value.isNull()) {
            return null;
        }
        if (value.isTextual()) {
            return Area.parse(value.asText());
        }
        if (value.isObject() && value.path("south").isNumber() && value.path("west").isNumber()
                && value.path("north").isNumber() && value.path("east").isNumber()) {
            return new Area("box", value.get("south").asDouble(), value.get("north").asDouble(),
                    value.get("west").asDouble(), value.get("east").asDouble());
        }
        throw ApiException.bad("area must be a name, or {\"south\": .., \"west\": .., \"north\": .., \"east\": ..}");
    }

    // ---- running

    private void run(Job job, SimSettings simSettings, Path demandFile, URI demandUrl, Path source) {
        Timetable timetable;
        synchronized (job) {
            if (job.stopAsked) {
                return; // stopped while it waited
            }
            job.state = State.RUNNING;
            job.startedAt = now();
            timetable = job.lease.loaded().router().timetable();
        }
        Path fetched = null;
        try {
            clear(job.folder);
            gtfseditor.router.sim.Progress progress = (stage, done, total) -> {
                synchronized (job) {
                    job.stage = stage;
                    job.done = done;
                    job.total = total;
                }
            };
            if (job.kind.equals("bau")) {
                Path file = demandFile;
                if (file == null) {
                    progress.at("fetch", 0, 0);
                    fetched = fetch(demandUrl, job.id);
                    file = fetched;
                }
                progress.at("read", 0, 0);
                DemandReader.Read read = DemandReader.read(file);
                SimRun.bau(timetable, read.demand(), read.report(), simSettings, job.name, job.folder, progress);
            } else if (job.kind.equals("scenario")) {
                SimRun.scenario(timetable, source, simSettings, job.name, job.folder, progress);
            } else {
                SimRun.withCapacity(timetable, source, simSettings, job.name, job.folder, progress);
            }
            JsonNode summary = mapper.readTree(Files.readAllBytes(job.folder.resolve("summary.json")));
            Instant finished = now();
            ObjectNode saved = JSON.objectNode().put("id", job.id).put("timetable", job.timetable)
                    .put("timetableVersion", job.version).put("submittedAt", job.submittedAt.toString())
                    .put("startedAt", job.startedAt.toString()).put("finishedAt", finished.toString());
            Files.write(job.folder.resolve(JOB_FILE), mapper.writeValueAsBytes(saved));
            synchronized (job) {
                job.summary = summary;
                job.finishedAt = finished;
                job.state = State.DONE;
            }
        } catch (Exception | OutOfMemoryError e) {
            Thread.interrupted(); // a stop arrives as an interrupt; the folder still has to be cleared
            synchronized (job) {
                job.finishedAt = now();
                if (job.stopAsked) {
                    job.state = State.STOPPED;
                } else {
                    job.state = State.FAILED;
                    job.error = e instanceof OutOfMemoryError
                            ? "the service ran out of memory; run an area or a share of the demand, or raise its heap"
                            : e.getMessage() == null ? e.toString() : e.getMessage();
                    System.err.printf("Simulation run %s failed: %s%n", job.id, job.error);
                }
            }
            try {
                clear(job.folder);
            } catch (IOException left) {
                System.err.printf("Could not remove the files of run %s: %s%n", job.id, left.getMessage());
            }
        } finally {
            job.release();
            if (fetched != null) {
                try {
                    Files.deleteIfExists(fetched);
                } catch (IOException e) {
                    // A fetched demand file left behind costs disk space only.
                }
            }
        }
    }

    /** Fetches a demand file into the data folder, keeping {@code .gz} if the address ends in it. */
    private Path fetch(URI address, String id) throws IOException, InterruptedException {
        Path incoming = settings.sims().resolve(".incoming");
        Files.createDirectories(incoming);
        Path file = incoming.resolve(id + (address.getPath() != null && address.getPath().endsWith(".gz") ? ".csv.gz" : ".csv"));
        try (HttpClient client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NORMAL)
                .connectTimeout(Duration.ofSeconds(20)).build()) {
            HttpResponse<Path> response;
            try {
                response = client.send(HttpRequest.newBuilder(address).timeout(FETCH_TIMEOUT).build(),
                        HttpResponse.BodyHandlers.ofFile(file));
            } catch (IOException e) {
                Files.deleteIfExists(file);
                throw new IOException("could not fetch " + address + ": "
                        + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()), e);
            } catch (InterruptedException e) {
                client.shutdownNow();
                Files.deleteIfExists(file);
                throw e;
            }
            if (response.statusCode() != 200) {
                Files.deleteIfExists(file);
                throw new IOException("fetching " + address + " answered " + response.statusCode());
            }
            return file;
        }
    }

    /** Removes a folder and everything in it, if it is there. */
    private static void clear(Path folder) throws IOException {
        if (!Files.exists(folder)) {
            return;
        }
        List<Path> all;
        try (var files = Files.walk(folder)) {
            all = files.sorted(Comparator.reverseOrder()).toList();
        }
        for (Path file : all) {
            Files.deleteIfExists(file);
        }
    }

    // ---- following and collecting

    synchronized ArrayNode list() {
        ArrayNode all = JSON.arrayNode();
        for (Job job : jobs.values()) {
            all.add(describe(job, false));
        }
        return all;
    }

    ObjectNode view(String id) {
        return describe(job(id), true);
    }

    private synchronized Job job(String id) {
        Job job = jobs.get(id);
        if (job == null) {
            throw new ApiException(404, "there is no run '" + id + "'");
        }
        return job;
    }

    private static String name(State state) {
        return state.name().toLowerCase(java.util.Locale.ROOT);
    }

    private ObjectNode describe(Job job, boolean full) {
        int ahead = 0;
        if (full) {
            synchronized (this) {
                for (Job other : jobs.values()) {
                    if (other == job) {
                        break;
                    }
                    State state;
                    synchronized (other) {
                        state = other.state;
                    }
                    ahead += state == State.QUEUED || state == State.RUNNING ? 1 : 0;
                }
            }
        }
        synchronized (job) {
            ObjectNode node = JSON.objectNode().put("id", job.id).put("name", job.name).put("kind", job.kind)
                    .put("state", name(job.state)).put("timetable", job.timetable)
                    .put("timetableVersion", job.version);
            if (job.submittedAt != null) {
                node.put("submittedAt", job.submittedAt.toString());
            }
            if (job.startedAt != null) {
                node.put("startedAt", job.startedAt.toString());
                Instant until = job.finishedAt != null ? job.finishedAt : Instant.now();
                node.put("elapsedSecs", Math.max(0, Duration.between(job.startedAt, until).toSeconds()));
            }
            if (job.finishedAt != null) {
                node.put("finishedAt", job.finishedAt.toString());
            }
            if (job.state == State.QUEUED && full) {
                node.put("runsAhead", ahead);
            }
            if (job.state == State.RUNNING) {
                node.putObject("progress").put("stage", job.stage).put("done", job.done).put("total", job.total);
            }
            if (job.error != null) {
                node.put("error", job.error);
            }
            if (job.state == State.DONE) {
                if (full) {
                    node.set("summary", job.summary);
                    ArrayNode files = node.putArray("files");
                    for (String file : SimRun.RESULT_FILES) {
                        if (Files.isRegularFile(job.folder.resolve(file))) {
                            files.add(file);
                        }
                    }
                } else {
                    node.set("people", job.summary.path("people"));
                }
            }
            return node;
        }
    }

    /** One result file of a finished run. */
    Path file(String id, String name) {
        Job job = job(id);
        synchronized (job) {
            if (job.state != State.DONE) {
                throw new ApiException(409, "run '" + id + "' is " + name(job.state) + "; it has files when it is done");
            }
        }
        Path file = job.folder.resolve(name);
        if (!SimRun.RESULT_FILES.contains(name) || !Files.isRegularFile(file)) {
            throw new ApiException(404, "run '" + id + "' has no file '" + name + "'; it has " + SimRun.RESULT_FILES);
        }
        return file;
    }

    // ---- stopping and discarding

    /**
     * Stops a run that is waiting or running, or discards one that has ended, files and all.
     *
     * @param force discard a finished run even though other runs were made from it
     * @return the run as it now is if it was stopped and is still listed; null if it was discarded
     */
    ObjectNode delete(String id, boolean force) {
        Job job = job(id);
        Future<?> work = null;
        synchronized (job) {
            if (job.state == State.QUEUED || job.state == State.RUNNING) {
                job.stopAsked = true;
                work = job.work;
                if (job.state == State.QUEUED) {
                    job.state = State.STOPPED;
                    job.finishedAt = now();
                }
            }
        }
        if (work != null) {
            work.cancel(true); // a running run is interrupted; one still waiting never starts
            synchronized (job) {
                if (job.state == State.STOPPED) {
                    job.release();
                }
            }
            return describe(job, true);
        }
        synchronized (this) {
            if (job.state == State.DONE) {
                List<String> dependents = dependents(job);
                if (!dependents.isEmpty() && !force) {
                    throw new ApiException(409, "runs " + dependents + " were made from run '" + id + "' and need it:"
                            + " a scenario run reads its BAU run's demand, and capacity is added from kept plans."
                            + " Discard them first, or add ?force=true");
                }
                try {
                    clear(job.folder);
                } catch (IOException e) {
                    throw new ApiException(500, "could not remove the files of run '" + id + "': " + e.getMessage());
                }
            }
            jobs.remove(id);
        }
        return null;
    }

    /** The finished runs that read this one's files. Called holding the lock. */
    private List<String> dependents(Job job) {
        List<String> found = new ArrayList<>();
        String folder = job.folder.toAbsolutePath().toString();
        for (Job other : jobs.values()) {
            if (other == job || other.state != State.DONE) {
                continue;
            }
            try {
                Properties properties = SimRun.properties(other.folder);
                if (same(folder, properties.getProperty("bau")) || same(folder, properties.getProperty("plans"))) {
                    found.add(other.id);
                }
            } catch (IOException | RuntimeException e) {
                // A run whose record cannot be read depends on nothing we can name.
            }
        }
        return found;
    }

    private static boolean same(String folder, String recorded) {
        return recorded != null && Path.of(recorded).toAbsolutePath().normalize().equals(Path.of(folder).normalize());
    }

    @Override
    public void close() {
        runner.shutdownNow();
        synchronized (this) {
            for (Job job : jobs.values()) {
                synchronized (job) {
                    job.stopAsked = job.state == State.QUEUED || job.state == State.RUNNING;
                }
            }
        }
    }
}
