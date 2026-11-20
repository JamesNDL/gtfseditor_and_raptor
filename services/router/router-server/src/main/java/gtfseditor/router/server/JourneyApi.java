package gtfseditor.router.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.core.Assignment;
import gtfseditor.router.core.Capacity;
import gtfseditor.router.core.CapacityMode;
import gtfseditor.router.core.Crowding;
import gtfseditor.router.core.Journey;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Mode;
import gtfseditor.router.core.Place;
import gtfseditor.router.core.Preferences;
import gtfseditor.router.core.Query;
import gtfseditor.router.core.Result;
import gtfseditor.router.core.Router;
import gtfseditor.router.core.Timetable;
import java.io.IOException;
import java.io.OutputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * {@code POST /v1/journeys} and {@code POST /v1/journeys/bulk}: reads the request, plans the
 * journeys and writes the answer. See sections 8.2 and 8.3 of docs/router-plan.md.
 */
final class JourneyApi {

    /** The latest time a request may give: 36:00:00, as section 6.4 of the plan says. */
    static final int MAX_DEPART = 36 * 3600;
    /** The furthest a request may ask to walk to its first stop or from its last, in a straight line. */
    static final double MAX_WALK_METRES = 5000;

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private JourneyApi() {}

    // ---- what a request says

    /** One end of a journey as the request gives it, before the timetable is known. */
    record Spot(String stop, String station, double lat, double lon) {

        static Spot read(JsonNode node, String which) {
            String shape = "'" + which + "' must be given as {\"stop\": id}, {\"station\": id} or {\"lat\": .., \"lon\": ..}";
            if (node == null || !node.isObject()) {
                throw ApiException.bad(shape);
            }
            if (node.hasNonNull("stop")) {
                return new Spot(node.get("stop").asText(), null, 0, 0);
            }
            if (node.hasNonNull("station")) {
                return new Spot(null, node.get("station").asText(), 0, 0);
            }
            JsonNode lat = node.get("lat");
            JsonNode lon = node.get("lon");
            if (lat == null || lon == null || !lat.isNumber() || !lon.isNumber() || Math.abs(lat.asDouble()) > 90
                    || Math.abs(lon.asDouble()) > 180) {
                throw ApiException.bad(shape);
            }
            return new Spot(null, null, lat.asDouble(), lon.asDouble());
        }

        /**
         * A {@code stop} that names a station is taken as the station, because the editor's own ids
         * do not say which is which.
         */
        Place place(Timetable t, String which) {
            if (stop != null) {
                int index = t.stopIndex(stop);
                if (index >= 0) {
                    return new Place.Stop(index);
                }
                int asStation = t.stationIndex(stop);
                if (asStation >= 0) {
                    return new Place.Station(asStation);
                }
                throw ApiException.bad("'" + which + "': no trip in this timetable calls at a stop '" + stop + "'");
            }
            if (station != null) {
                int index = t.stationIndex(station);
                if (index < 0) {
                    throw ApiException.bad("'" + which + "': there is no station '" + station + "' in this timetable");
                }
                return new Place.Station(index);
            }
            return new Place.Point(lat, lon);
        }
    }

    /**
     * The settings a request gives once, for one journey or for many.
     *
     * @param timetable  the timetable's id, or null for the only one loaded
     * @param loads      the name of the load state, or null when the mode is off
     * @param maxRides   0 for the router's limit
     * @param avoid      kinds of vehicle to leave out, or null for the usual ones
     * @param changeSecs least time to change at one stop, or -1 for the usual
     * @param legs       whether ride legs list the stops they pass
     */
    record Options(String timetable, CapacityMode mode, String loads, double fullAt, int sliceSecs, int maxTries,
            int maxRides, double maxWalkMetres, Set<Mode> avoid, int changeSecs, boolean lessWalking, boolean legs) {

        /** @param bulk whether this is a bulk request, which gives a summary unless it asks for legs */
        static Options read(JsonNode body, boolean bulk) {
            if (body == null || !body.isObject()) {
                throw ApiException.bad("the request must be a JSON object");
            }
            JsonNode capacity = body.path("capacity");
            CapacityMode mode = CapacityMode.OFF;
            if (capacity.hasNonNull("mode")) {
                try {
                    mode = CapacityMode.parse(capacity.get("mode").asText());
                } catch (IllegalArgumentException e) {
                    throw ApiException.bad(e.getMessage());
                }
            }
            String loads = capacity.hasNonNull("loads") ? capacity.get("loads").asText() : null;
            if (mode != CapacityMode.OFF && loads == null) {
                throw ApiException.bad("capacity mode '" + mode.wireName() + "' needs the name of a load state:"
                        + " {\"mode\": \"" + mode.wireName() + "\", \"loads\": name}");
            }
            String detail = body.hasNonNull("detail") ? body.get("detail").asText() : bulk ? "summary" : "legs";
            if (!detail.equals("legs") && !detail.equals("summary")) {
                throw ApiException.bad("detail must be legs or summary, not '" + detail + "'");
            }
            Set<Mode> avoid = null;
            JsonNode avoiding = body.get("avoid");
            if (avoiding != null && !avoiding.isNull()) {
                if (!avoiding.isArray()) {
                    throw ApiException.bad("avoid must be a list of kinds of vehicle, such as [\"school_bus\"]");
                }
                avoid = EnumSet.noneOf(Mode.class);
                for (JsonNode name : avoiding) {
                    try {
                        avoid.add(Mode.valueOf(name.asText().strip().toUpperCase(Locale.ROOT)));
                    } catch (IllegalArgumentException e) {
                        throw ApiException.bad("'" + name.asText() + "' is not a kind of vehicle; the kinds are "
                                + EnumSet.allOf(Mode.class).stream().map(Mode::wireName).toList());
                    }
                }
            }
            JsonNode less = body.path("lessWalking");
            if (!less.isMissingNode() && !less.isBoolean()) {
                throw ApiException.bad("lessWalking must be true or false");
            }
            return new Options(
                    body.hasNonNull("timetable") ? body.get("timetable").asText() : null,
                    mode,
                    mode == CapacityMode.OFF ? null : loads,
                    number(capacity, "fullAt", 1.0, 0.01, 10),
                    (int) number(capacity, "sliceSecs", Assignment.DEFAULT_SLICE_SECS, 1, 86400),
                    (int) number(capacity, "maxTries", Assignment.DEFAULT_MAX_TRIES, 1, 20),
                    (int) number(body, "maxRides", 0, 1, 100),
                    number(body, "maxWalkMetres", Router.DEFAULT_MAX_WALK_METRES, 0, MAX_WALK_METRES),
                    avoid,
                    (int) number(body, "changeSecs", -1, 0, 3600),
                    less.asBoolean(false),
                    detail.equals("legs"));
        }
    }

    /**
     * One journey asked for.
     *
     * @param id    the caller's name for it, or null
     * @param error why it cannot be planned, or null; then the other values mean nothing
     */
    record Item(String id, Spot from, Spot to, int depart, int group, String error) {

        /** @throws ApiException if the journey cannot be read */
        static Item read(JsonNode node) {
            if (node == null || !node.isObject()) {
                throw ApiException.bad("a query must be a JSON object");
            }
            return new Item(node.hasNonNull("id") ? node.get("id").asText() : null, Spot.read(node.get("from"), "from"),
                    Spot.read(node.get("to"), "to"), time(node.get("depart")), (int) number(node, "group", 1, 1, 10_000),
                    null);
        }

        /** The same, but a journey that cannot be read is kept, with the reason, to be reported in its turn. */
        static Item readOrError(JsonNode node) {
            try {
                return read(node);
            } catch (ApiException e) {
                String id = node != null && node.hasNonNull("id") ? node.get("id").asText() : null;
                return new Item(id, null, null, 0, 1, e.getMessage());
            }
        }
    }

    /** A boarding the passenger has been refused: a trip at a stop, by their GTFS ids. */
    record Refused(String trip, String stop) {

        static List<Refused> read(JsonNode body) {
            List<Refused> refused = new ArrayList<>();
            JsonNode list = body.get("blocked");
            if (list == null || list.isNull()) {
                return refused;
            }
            if (!list.isArray()) {
                throw ApiException.bad("blocked must be a list such as [{\"trip\": id, \"stop\": id}]");
            }
            for (JsonNode node : list) {
                if (!node.hasNonNull("trip") || !node.hasNonNull("stop")) {
                    throw ApiException.bad("blocked must be a list such as [{\"trip\": id, \"stop\": id}]");
                }
                refused.add(new Refused(node.get("trip").asText(), node.get("stop").asText()));
            }
            return refused;
        }

        /** Refuses the trip at every position along it that is this stop. */
        Capacity applyTo(Capacity capacity, Timetable t) {
            int tripIndex = t.tripIndex(trip);
            int stopIndex = t.stopIndex(stop);
            if (tripIndex < 0 || stopIndex < 0) {
                throw ApiException.bad("blocked: there is no trip '" + trip + "' or no stop '" + stop + "' in this timetable");
            }
            int first = t.patternStopOffset[t.tripPattern[tripIndex]];
            for (int position = 0; position < t.patternLength(t.tripPattern[tripIndex]); position++) {
                if (t.patternStops[first + position] == stopIndex) {
                    capacity = capacity.blocking(t, tripIndex, position);
                }
            }
            return capacity;
        }
    }

    // ---- planning

    /** The load state a request names, or null when it asks for none. */
    private static Timetables.Loads loadsFor(Timetables.Loaded loaded, Options options) {
        if (options.mode() == CapacityMode.OFF) {
            return null;
        }
        Timetables.Loads loads = loaded.loads().get(options.loads());
        if (loads == null) {
            throw new ApiException(404, "timetable '" + loaded.id() + "' has no load state '" + options.loads() + "'");
        }
        return loads;
    }

    private static Query query(Router router, Options options, Place from, Place to, int depart) {
        Query query = router.query(from, to, depart,
                options.maxRides() == 0 ? router.maxRides() : options.maxRides(), options.maxWalkMetres());
        if (options.avoid() != null) {
            query = query.avoiding(options.avoid());
        }
        if (options.changeSecs() >= 0) {
            query = query.withChangeSecs(options.changeSecs());
        }
        return query;
    }

    /**
     * Plans the requests on the timetable's own threads and hands each outcome to the sink, on the
     * calling thread. Only one run at a time may add passengers to a load state.
     *
     * @param begun run once everything that can refuse the request has been checked
     */
    private static void run(Timetables.Loaded loaded, Options options, Assignment.Requests requests, Runnable begun,
            Assignment.Sink sink) {
        Timetables.Loads loads = loadsFor(loaded, options);
        Assignment.Settings settings = new Assignment.Settings(options.mode(), loads == null ? null : loads.state(),
                options.fullAt(), options.sliceSecs(), options.maxTries());
        boolean assigning = options.mode() == CapacityMode.ASSIGN;
        if (assigning && !loads.assigning().tryLock()) {
            throw new ApiException(409, "another request is adding passengers to load state '" + loads.name()
                    + "'; try again when it has finished");
        }
        try {
            begun.run();
            Assignment.run(loaded.router(), requests, options.lessWalking() ? Preferences.lessWalking()
                    : Preferences.defaults(), settings, loaded.workers(), sink);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new ApiException(503, "the service is stopping");
        } finally {
            if (assigning) {
                loads.assigning().unlock();
            }
        }
    }

    /** The loads and group a journey was planned with, for reporting how full its rides are; or null. */
    private static Capacity crowdingFor(Timetables.Loaded loaded, Options options, int group) {
        Timetables.Loads loads = loadsFor(loaded, options);
        return loads == null ? null : Capacity.of(loads.state(), options.fullAt(), group);
    }

    /** A departure before this is answered with a warning: see {@link #single}. */
    private static final int SMALL_HOURS_END = 4 * 3600;

    /** Answers {@code POST /v1/journeys}. */
    static ObjectNode single(Timetables.Loaded loaded, JsonNode body) {
        Options options = Options.read(body, false);
        Item item = Item.read(body);
        List<Refused> refused = Refused.read(body);
        Router router = loaded.router();
        Timetable t = router.timetable();
        Place from = item.from().place(t, "from");
        Place to = item.to().place(t, "to");
        Assignment.Requests one = new Assignment.Requests() {
            @Override
            public int count() {
                return 1;
            }

            @Override
            public int depart(int i) {
                return item.depart();
            }

            @Override
            public int group(int i) {
                return item.group();
            }

            @Override
            public Query query(int i) {
                return JourneyApi.query(router, options, from, to, item.depart());
            }

            @Override
            public Capacity capacity(int i, Capacity capacity) {
                for (Refused boarding : refused) {
                    capacity = boarding.applyTo(capacity, t);
                }
                return capacity;
            }
        };
        one.capacity(0, Capacity.OFF); // so that a refusal that cannot be read is reported before anything is planned
        Assignment.Outcome[] settled = new Assignment.Outcome[1];
        run(loaded, options, one, () -> { }, (request, outcome) -> settled[0] = outcome);
        Assignment.Outcome outcome = settled[0];
        Result result = outcome.result();

        ObjectNode answer = JSON.objectNode();
        answer.putObject("timetable").put("id", loaded.id()).put("version", loaded.version());
        answer.put("capacityMode", options.mode().wireName());
        if (options.loads() != null) {
            answer.put("loads", options.loads());
        }
        answer.put("status", status(outcome.status()));
        if (outcome.journey() == null) {
            answer.put("reason", reason(outcome, options));
        }
        if (item.depart() < SMALL_HOURS_END) {
            // "00:20" is the small hours at the start of the service day, when little runs; the
            // caller may have meant twenty past midnight at the end of it, which is "24:20".
            answer.put("warning", "The time asked for is before 04:00 at the start of the service day. For a journey"
                    + " after midnight at the end of the day, keep counting past 24:00: \"24:20\", not \"00:20\".");
        }
        // What was found is listed even when the passenger could not be given any of it.
        answer.put("recommended", result.recommended());
        if (options.mode() == CapacityMode.ASSIGN) {
            answer.put("assigned", outcome.journey() == null ? -1 : result.recommended());
            answer.put("tries", outcome.tries());
        }
        ArrayNode journeys = answer.putArray("journeys");
        ObjectNode start = describe(t, from);
        ObjectNode end = describe(t, to);
        Capacity crowding = crowdingFor(loaded, options, item.group());
        for (int i = 0; i < result.journeys().size(); i++) {
            ObjectNode journey = journey(t, outcome.query(), result.journeys().get(i), start, end, options.legs(), crowding);
            journey.put("recommended", i == result.recommended());
            journeys.add(journey);
        }
        answer.put("computeMicros", result.computeNanos() / 1000);
        return answer;
    }

    /**
     * Answers {@code POST /v1/journeys/bulk}: one line of JSON for each journey as it is settled,
     * then a line of totals.
     *
     * @param begun run once the request is known to be answerable and before the first line, to
     *              send the headers
     */
    static void bulk(Timetables.Loaded loaded, Options options, List<Item> items, ObjectMapper mapper,
            Runnable begun, OutputStream out) throws IOException {
        Router router = loaded.router();
        Timetable t = router.timetable();
        // Find every place first, so a journey that names a stop the timetable does not have is
        // reported and the rest are planned.
        int[] which = new int[items.size()];
        Place[] from = new Place[items.size()];
        Place[] to = new Place[items.size()];
        String[] errors = new String[items.size()];
        int valid = 0;
        for (int i = 0; i < items.size(); i++) {
            Item item = items.get(i);
            errors[i] = item.error();
            if (errors[i] == null) {
                try {
                    from[i] = item.from().place(t, "from");
                    to[i] = item.to().place(t, "to");
                    which[valid++] = i;
                } catch (ApiException e) {
                    errors[i] = e.getMessage();
                }
            }
        }
        int count = valid;
        Assignment.Requests requests = new Assignment.Requests() {
            @Override
            public int count() {
                return count;
            }

            @Override
            public int depart(int i) {
                return items.get(which[i]).depart();
            }

            @Override
            public int group(int i) {
                return items.get(which[i]).group();
            }

            @Override
            public Query query(int i) {
                return JourneyApi.query(router, options, from[which[i]], to[which[i]], items.get(which[i]).depart());
            }
        };

        long started = System.nanoTime();
        int[] totals = new int[5]; // ok, noJourney, stranded, rerouted, lines since the last flush
        try {
            run(loaded, options, requests, () -> {
                begun.run();
                for (int i = 0; i < items.size(); i++) {
                    if (errors[i] != null) {
                        ObjectNode line = JSON.objectNode();
                        if (items.get(i).id() != null) {
                            line.put("id", items.get(i).id());
                        }
                        write(out, mapper, line.put("status", "error").put("error", errors[i]));
                    }
                }
            }, (request, outcome) -> {
                int i = which[request];
                Item item = items.get(i);
                ObjectNode line = JSON.objectNode();
                if (item.id() != null) {
                    line.put("id", item.id());
                }
                line.put("status", status(outcome.status()));
                if (options.mode() == CapacityMode.ASSIGN) {
                    line.put("tries", outcome.tries());
                }
                if (outcome.journey() == null) {
                    line.put("reason", reason(outcome, options));
                } else {
                    line.set("journey", journey(t, outcome.query(), outcome.journey(), describe(t, from[i]),
                            describe(t, to[i]), options.legs(), crowdingFor(loaded, options, item.group())));
                }
                totals[outcome.status().ordinal()]++;
                totals[3] += outcome.tries() > 1 ? 1 : 0;
                write(out, mapper, line);
                if (++totals[4] == 256) {
                    totals[4] = 0;
                    flush(out);
                }
            });
        } catch (UncheckedIOException e) {
            throw e.getCause(); // the caller has gone away
        }
        double seconds = (System.nanoTime() - started) / 1e9;
        ObjectNode summary = JSON.objectNode();
        ObjectNode body = summary.putObject("summary");
        body.putObject("timetable").put("id", loaded.id()).put("version", loaded.version());
        body.put("capacityMode", options.mode().wireName());
        if (options.loads() != null) {
            body.put("loads", options.loads());
        }
        body.put("queries", items.size()).put("ok", totals[Result.Status.OK.ordinal()])
                .put("noJourney", totals[Result.Status.NO_JOURNEY.ordinal()])
                .put("stranded", totals[Result.Status.STRANDED.ordinal()]).put("errors", items.size() - count);
        if (options.mode() == CapacityMode.ASSIGN) {
            body.put("rerouted", totals[3]);
        }
        body.put("elapsedSecs", Math.round(seconds * 1000) / 1000.0)
                .put("perSecond", seconds > 0 ? Math.round(count / seconds) : 0);
        try {
            write(out, mapper, summary);
            flush(out);
        } catch (UncheckedIOException e) {
            throw e.getCause();
        }
    }

    private static void write(OutputStream out, ObjectMapper mapper, ObjectNode line) {
        try {
            out.write(mapper.writeValueAsBytes(line));
            out.write('\n');
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    private static void flush(OutputStream out) {
        try {
            out.flush();
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    // ---- writing an answer

    private static String status(Result.Status status) {
        return switch (status) {
            case OK -> "ok";
            case NO_JOURNEY -> "noJourney";
            case STRANDED -> "stranded";
        };
    }

    private static String reason(Assignment.Outcome outcome, Options options) {
        Query query = outcome.query();
        if (outcome.result().status() == Result.Status.NO_JOURNEY) {
            return query.access().isEmpty() || query.egress().isEmpty()
                    ? "There is no stop within walking distance of one end."
                    : "Nothing gets there on this service day after that time.";
        }
        return outcome.result().status() == Result.Status.STRANDED
                ? "There is a way, but no room on it: every trip that could be boarded is full."
                : "No journey with room all the way was found in " + options.maxTries() + " tries.";
    }

    /**
     * @param crowding the loads the journey was planned with, to report how full each ride is; or
     *                 null to leave that out
     */
    private static ObjectNode journey(Timetable t, Query query, Journey j, ObjectNode start, ObjectNode end,
            boolean withStops, Capacity crowding) {
        ObjectNode journey = JSON.objectNode();
        journey.put("label", j.label());
        journey.put("depart", j.depart());
        journey.put("arrive", j.arrive());
        journey.put("durationSecs", j.durationSecs());
        journey.put("rides", j.rides());
        journey.put("changes", j.changes());
        journey.put("walkSecs", j.walkSecs());
        journey.put("waitSecs", j.waitSecs());
        ArrayNode legs = journey.putArray("legs");
        for (int i = 0; i < j.legs().size(); i++) {
            ObjectNode leg = leg(t, j.legs().get(i), start, end, withStops);
            if (crowding != null && j.legs().get(i).kind() == Leg.Kind.RIDE) {
                Crowding c = Crowding.of(t, query, j, i, crowding);
                leg.putObject("crowding").put("peakLoad", c.peakLoad()).put("capacity", c.capacity())
                        .put("peakFactor", Math.round(c.peakFactor() * 1000) / 1000.0)
                        .put("capacityIsPlaceholder", c.placeholder());
                leg.put("skippedFullTrips", c.skippedFull());
            }
            legs.add(leg);
        }
        return journey;
    }

    private static ObjectNode leg(Timetable t, Leg leg, ObjectNode start, ObjectNode end, boolean withStops) {
        ObjectNode node = JSON.objectNode();
        if (leg.kind() != Leg.Kind.RIDE) {
            node.put("type", leg.kind() == Leg.Kind.WALK ? "walk" : "transfer");
            node.set("from", leg.fromStop() < 0 ? start.deepCopy() : stop(t, leg.fromStop()));
            node.set("to", leg.toStop() < 0 ? end.deepCopy() : stop(t, leg.toStop()));
            node.put("depart", leg.depart());
            node.put("arrive", leg.arrive());
            node.put("metres", leg.metres());
            return node;
        }
        int trip = leg.trip();
        int route = t.tripRoute[trip];
        node.put("type", "ride");
        node.put("trip", t.tripIds[trip]);
        node.put("route", t.routeNames[route]);
        node.put("routeId", t.routeIds[route]);
        node.put("mode", t.tripMode(trip).wireName());
        node.put("headsign", t.tripHeadsigns[trip]);
        node.put("depart", leg.depart());
        node.put("arrive", leg.arrive());
        node.set("board", stop(t, leg.fromStop()).put("time", leg.depart()).put("position", leg.boardPosition()));
        node.set("alight", stop(t, leg.toStop()).put("time", leg.arrive()).put("position", leg.alightPosition()));
        if (withStops) {
            ArrayNode stops = node.putArray("stops");
            int first = t.patternStopOffset[t.tripPattern[trip]];
            for (int position = leg.boardPosition(); position <= leg.alightPosition(); position++) {
                int time = t.tripTimeIndex(trip, position);
                stops.add(stop(t, t.patternStops[first + position])
                        .put("arrive", t.arrive[time]).put("depart", t.depart[time]));
            }
        }
        node.put("stayAboard", leg.stayAboard());
        return node;
    }

    private static ObjectNode stop(Timetable t, int stop) {
        return JSON.objectNode().put("stop", t.stopIds[stop]).put("name", t.stopNames[stop])
                .put("lat", t.stopLat[stop]).put("lon", t.stopLon[stop]);
    }

    private static ObjectNode describe(Timetable t, Place place) {
        return switch (place) {
            case Place.Stop s -> stop(t, s.stop());
            case Place.Station s -> JSON.objectNode().put("station", t.stationIds[s.station()])
                    .put("name", t.stationNames[s.station()]);
            case Place.Point p -> JSON.objectNode().put("lat", p.lat()).put("lon", p.lon());
        };
    }

    // ---- reading values

    /** Reads seconds from the start of the service day, or {@code HH:MM} or {@code HH:MM:SS} up to 36:00:00. */
    static int time(JsonNode node) {
        int seconds = -1;
        if (node != null && node.isIntegralNumber() && node.canConvertToInt()) {
            seconds = node.asInt();
        } else if (node != null && node.isTextual()) {
            String[] parts = node.asText().strip().split(":");
            try {
                if (parts.length == 2 || parts.length == 3) {
                    int hours = Integer.parseInt(parts[0]);
                    int minutes = Integer.parseInt(parts[1]);
                    int secs = parts.length == 3 ? Integer.parseInt(parts[2]) : 0;
                    if (hours >= 0 && minutes >= 0 && minutes < 60 && secs >= 0 && secs < 60) {
                        seconds = hours * 3600 + minutes * 60 + secs;
                    }
                }
            } catch (NumberFormatException e) {
                // reported below
            }
        }
        if (seconds < 0 || seconds > MAX_DEPART) {
            throw ApiException.bad("depart must be a time such as \"07:45:00\", up to \"36:00:00\", or seconds from"
                    + " the start of the service day");
        }
        return seconds;
    }

    private static double number(JsonNode body, String name, double otherwise, double least, double most) {
        JsonNode node = body.get(name);
        if (node == null || node.isNull()) {
            return otherwise;
        }
        if (!node.isNumber() || !(node.asDouble() >= least) || !(node.asDouble() <= most)) {
            throw ApiException.bad(name + " must be a number from " + (least < 1 ? String.valueOf(least)
                    : String.valueOf((long) least)) + " to " + (long) most);
        }
        return node.asDouble();
    }
}
