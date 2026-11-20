package gtfseditor.router.server;

import gtfseditor.router.core.LoadState;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.TimetableStats;
import gtfseditor.router.gtfs.LoadOptions;
import gtfseditor.router.gtfs.TimetableCache;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.locks.ReentrantLock;

/**
 * The timetables the service holds, each under an id the caller chose. See section 6.5 of
 * docs/router-plan.md.
 *
 * <p>A load or reload builds the new timetable beside the old one and swaps it in when it is ready;
 * journeys keep being planned on the old one until then, and a build that fails leaves the old one
 * in place. One build runs at a time, because a build is the most memory the service uses.
 *
 * <p>Each loaded timetable has its own threads for planning. A search keeps about 16 MB of working
 * memory per thread; ending the threads with the timetable is what gives that memory back.
 */
final class Timetables implements AutoCloseable {

    /** Where a timetable's zip came from: {@code path}, {@code url} or {@code upload}. */
    record Source(String kind, String value) {}

    /**
     * A timetable that journeys can be planned on.
     *
     * @param loads its load states, by name. They belong to this version of the timetable and go
     *              when it is replaced.
     */
    record Loaded(String id, String version, Source source, Router router, TimetableStats stats, Instant loadedAt,
            double loadSecs, boolean fromSnapshot, ExecutorService workers, Map<String, Loads> loads, Users users) {}

    /**
     * A named load state.
     *
     * @param assigning held by the one bulk run that may add passengers to it at a time
     */
    record Loads(String name, LoadState state, Instant createdAt, ReentrantLock assigning) {}

    /** Who is still planning on a timetable. Its threads end when it is retired and nobody is. */
    static final class Users {
        private int count;
        private boolean retired;
    }

    /** The use of a timetable for a while. Its threads stay until this is closed, even if it is replaced. */
    final class Lease implements AutoCloseable {
        private final Loaded loaded;

        private Lease(Loaded loaded) {
            this.loaded = loaded;
        }

        Loaded loaded() {
            return loaded;
        }

        @Override
        public void close() {
            synchronized (Timetables.this) {
                Users users = loaded.users();
                if (--users.count == 0 && users.retired) {
                    loaded.workers().shutdown();
                }
            }
        }
    }

    /** A build that is waiting or running. */
    record Build(String version, Source source, Instant startedAt) {}

    /** The last build that failed, if none has succeeded since. */
    record Failure(String version, Source source, Instant at, String message) {}

    /** One id as the caller sees it. Any of the three may be null, but not all. */
    record View(String id, Loaded loaded, Build building, Failure failure) {}

    /** Gets the zip to build from; run on the build thread, so it may take minutes. */
    interface ZipStep {
        Path zip() throws Exception;
    }

    /** Gets what else the build needs, such as a water file to fetch; run on the build thread. */
    interface OptionsStep {
        LoadOptions options() throws Exception;
    }

    private static final class Entry {
        final String id;
        Loaded loaded;
        Build building;
        Failure failure;
        long lastUsed;

        Entry(String id) {
            this.id = id;
        }

        View view() {
            return new View(id, loaded, building, failure);
        }
    }

    private final Settings settings;
    private final Map<String, Entry> entries = new LinkedHashMap<>();
    private final ExecutorService builder = Executors.newSingleThreadExecutor(threads("router-build"));
    private long uses;

    Timetables(Settings settings) {
        this.settings = settings;
    }

    /** An id is 1 to 64 letters, digits, dots, dashes or underscores: it is used in file names. */
    static boolean isId(String text) {
        return text.matches("[A-Za-z0-9._-]{1,64}") && !text.startsWith(".");
    }

    synchronized List<View> list() {
        List<View> views = new ArrayList<>();
        for (Entry entry : entries.values()) {
            views.add(entry.view());
        }
        return views;
    }

    /** What is known about an id, or null if nothing is. */
    synchronized View view(String id) {
        Entry entry = entries.get(id);
        return entry == null ? null : entry.view();
    }

    /**
     * Notes that a build of this id is about to start, so that a second request cannot start
     * another. The caller must follow with {@link #build} or {@link #fail}.
     *
     * @param version the caller's name for these contents; blank means the time now
     * @throws ApiException if this id is already being built
     */
    synchronized View begin(String id, String version, Source source) {
        Entry entry = entries.computeIfAbsent(id, Entry::new);
        if (entry.building != null) {
            throw new ApiException(409, "timetable '" + id + "' is already being loaded; try again when it is ready");
        }
        Instant now = Instant.now().truncatedTo(ChronoUnit.SECONDS);
        entry.building = new Build(version == null || version.isBlank() ? now.toString() : version.strip(), source, now);
        return entry.view();
    }

    /** Queues the build begun by {@link #begin}. */
    void build(String id, LoadOptions options, ZipStep step) {
        build(id, () -> options, step);
    }

    /** Queues the build begun by {@link #begin}, working its options out on the build thread. */
    void build(String id, OptionsStep optionsStep, ZipStep step) {
        Entry entry;
        Build build;
        synchronized (this) {
            entry = entries.get(id);
            build = entry == null ? null : entry.building;
        }
        if (build == null) {
            throw new IllegalStateException("no build was begun for " + id);
        }
        Entry target = entry;
        builder.execute(() -> {
            try {
                long started = System.nanoTime();
                Path zip = step.zip();
                LoadOptions options = optionsStep.options();
                Files.createDirectories(settings.snapshots());
                TimetableCache.Loaded read = TimetableCache.load(zip, options, settings.snapshots());
                if (!build.source().kind().equals("path")) {
                    forgetOlderSnapshots(id, read.snapshot());
                }
                Router router = new Router(read.timetable());
                TimetableStats stats = TimetableStats.of(read.timetable());
                double seconds = (System.nanoTime() - started) / 1e9;
                Loaded loaded = new Loaded(id, build.version(), build.source(), router, stats,
                        Instant.now().truncatedTo(ChronoUnit.SECONDS), seconds, read.fromSnapshot(),
                        Executors.newFixedThreadPool(settings.threads(), threads("router-" + id)),
                        new ConcurrentHashMap<>(), new Users());
                finish(target, build, loaded);
            } catch (Exception | OutOfMemoryError e) {
                String message = e instanceof OutOfMemoryError ? "the service ran out of memory building it"
                        : e.getMessage() == null ? e.toString() : e.getMessage();
                fail(target, build, message);
            }
        });
    }

    /**
     * A zip that was fetched or uploaded is kept as {@code <id>.zip}, so each new version of it
     * leaves a snapshot named after the id. Only the newest is of any use.
     */
    private void forgetOlderSnapshots(String id, Path newest) {
        String pattern = java.util.regex.Pattern.quote(id) + "-[0-9a-f]{16}\\.timetable";
        try (var files = Files.list(settings.snapshots())) {
            for (Path file : files.toList()) {
                if (file.getFileName().toString().matches(pattern) && !file.getFileName().equals(newest.getFileName())) {
                    Files.deleteIfExists(file);
                }
            }
        } catch (java.io.IOException e) {
            // An old snapshot left behind costs disk space only.
        }
    }

    /** Records that the build begun by {@link #begin} could not even start. */
    synchronized void fail(String id, String message) {
        Entry entry = entries.get(id);
        if (entry != null && entry.building != null) {
            fail(entry, entry.building, message);
        }
    }

    private synchronized void fail(Entry entry, Build build, String message) {
        if (entry.building == build) {
            entry.building = null;
            entry.failure = new Failure(build.version(), build.source(),
                    Instant.now().truncatedTo(ChronoUnit.SECONDS), message);
            System.err.printf("Timetable %s (version %s) could not be loaded: %s%n", entry.id, build.version(), message);
        }
    }

    private synchronized void finish(Entry entry, Build build, Loaded loaded) {
        if (entries.get(entry.id) != entry || entry.building != build) {
            retire(loaded); // unloaded while it was being built
            return;
        }
        Loaded old = entry.loaded;
        entry.loaded = loaded;
        entry.building = null;
        entry.failure = null;
        entry.lastUsed = ++uses;
        if (old != null) {
            retire(old); // journeys already being planned on it finish first
        }
        System.out.printf("Timetable %s (version %s) loaded in %.1f s%s: %,d trips, %,d stops%n", entry.id,
                loaded.version(), loaded.loadSecs(), loaded.fromSnapshot() ? " from a snapshot" : "",
                loaded.stats().trips(), loaded.stats().stops());

        // Keep no more than the limit: drop whichever other timetable was used longest ago.
        while (entries.values().stream().filter(e -> e.loaded != null).count() > settings.maxTimetables()) {
            Entry oldest = null;
            for (Entry other : entries.values()) {
                if (other != entry && other.loaded != null && (oldest == null || other.lastUsed < oldest.lastUsed)) {
                    oldest = other;
                }
            }
            if (oldest == null) {
                break;
            }
            retire(oldest.loaded);
            oldest.loaded = null;
            if (oldest.building == null) {
                entries.remove(oldest.id);
            }
            System.out.printf("Timetable %s dropped to make room%n", oldest.id);
        }
    }

    /** Unloads an id, and forgets a build of it that is under way. False if the id is not known. */
    synchronized boolean remove(String id) {
        Entry entry = entries.remove(id);
        if (entry == null) {
            return false;
        }
        if (entry.loaded != null) {
            retire(entry.loaded);
        }
        return true;
    }

    /** Ends a timetable's threads, once nobody is planning on it. */
    private void retire(Loaded loaded) {
        if (loaded.users().count == 0) {
            loaded.workers().shutdown();
        } else {
            loaded.users().retired = true;
        }
    }

    /**
     * Takes a loaded timetable for a while. The caller must close the lease.
     *
     * @param id the timetable; null means the only one loaded
     * @throws ApiException if there is no such timetable or it is not ready
     */
    synchronized Lease lease(String id) {
        Loaded loaded = ready(id);
        loaded.users().count++;
        return new Lease(loaded);
    }

    /** Waits for work given to a timetable's threads, and hands on whatever went wrong with it. */
    static <T> T await(Future<T> work) {
        try {
            return work.get();
        } catch (ExecutionException e) {
            if (e.getCause() instanceof RuntimeException problem) {
                throw problem;
            }
            if (e.getCause() instanceof Error error) {
                throw error;
            }
            throw new IllegalStateException(e.getCause());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(503, "the service is stopping");
        }
    }

    private synchronized Loaded ready(String id) {
        Entry entry;
        if (id == null) {
            List<Entry> loaded = entries.values().stream().filter(e -> e.loaded != null).toList();
            if (loaded.size() != 1) {
                throw ApiException.bad(loaded.isEmpty() ? "no timetable is loaded"
                        : "say which timetable: " + loaded.stream().map(e -> e.id).toList());
            }
            entry = loaded.get(0);
        } else {
            entry = entries.get(id);
        }
        if (entry == null) {
            throw new ApiException(404, "there is no timetable '" + id + "'");
        }
        if (entry.loaded == null) {
            throw new ApiException(503, entry.building != null
                    ? "timetable '" + entry.id + "' is still being loaded"
                    : "timetable '" + entry.id + "' could not be loaded: " + entry.failure.message());
        }
        entry.lastUsed = ++uses;
        return entry.loaded;
    }

    @Override
    public synchronized void close() {
        builder.shutdownNow();
        for (Entry entry : entries.values()) {
            if (entry.loaded != null) {
                entry.loaded.workers().shutdownNow();
            }
        }
        entries.clear();
    }

    private static ThreadFactory threads(String name) {
        AtomicInteger count = new AtomicInteger();
        return work -> {
            Thread thread = new Thread(work, name + "-" + count.incrementAndGet());
            thread.setDaemon(true);
            return thread;
        };
    }
}
