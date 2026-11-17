package gtfseditor.router.gtfs;

import gtfseditor.router.core.Geo;
import gtfseditor.router.core.TransferSettings;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.PriorityQueue;

/**
 * Works out the walking links between stops. See section 6.3 of docs/router-plan.md.
 *
 * <p>Links come from four sources. When two sources link the same pair of stops, the first in this
 * list wins: the feed's own {@code transfers.txt}; the station pathways; two stops of one station;
 * two stops close together.
 */
final class TransferBuilder {

    private static final int FEED = 0;
    private static final int PATHWAY = 1;
    private static final int STATION = 2;
    private static final int NEARBY = 3;
    private static final int KINDS = 4;

    /** Marks a pair the feed says cannot be walked. */
    private static final int FORBIDDEN = -1;


    /** The finished links, ready for the timetable, and how many came from where. */
    record Result(int[] offset, int[] targets, int[] secs, int[] metres, List<String> notes) {}

    private final TransferSettings settings;
    private final double[] lat;
    private final double[] lon;
    private final int stops;
    private final List<String> notes = new ArrayList<>();

    // Every proposed link, before duplicates are settled.
    private final IntList from = new IntList(1 << 12);
    private final IntList to = new IntList(1 << 12);
    private final IntList secs = new IntList(1 << 12);
    private final IntList kind = new IntList(1 << 12);

    TransferBuilder(TransferSettings settings, double[] lat, double[] lon) {
        this.settings = settings;
        this.lat = lat;
        this.lon = lon;
        this.stops = lat.length;
    }

    private double metres(int a, int b) {
        return Geo.metresBetween(lat[a], lon[a], lat[b], lon[b]);
    }

    private void propose(int a, int b, int seconds, int source) {
        from.add(a);
        to.add(b);
        secs.add(seconds);
        kind.add(source);
    }

    /** Links every pair of stops within the radius, found with a grid so no pair is tested twice over. */
    void addNearby() {
        double radius = settings.radiusMetres();
        if (radius <= 0 || stops == 0) {
            return;
        }
        double minLat = Double.MAX_VALUE;
        double minLon = Double.MAX_VALUE;
        double steepest = 0;
        for (int s = 0; s < stops; s++) {
            minLat = Math.min(minLat, lat[s]);
            minLon = Math.min(minLon, lon[s]);
            steepest = Math.max(steepest, Math.abs(lat[s]));
        }
        // Cells are at least one radius across everywhere, so a stop's neighbours are in its own
        // cell or one of the eight around it.
        double cellLat = radius / Geo.METRES_PER_DEGREE;
        double cellLon = radius / (Geo.METRES_PER_DEGREE * Math.max(0.01, Math.cos(Math.toRadians(steepest))));
        int[] cellY = new int[stops];
        int[] cellX = new int[stops];
        Map<Long, IntList> cells = new HashMap<>();
        for (int s = 0; s < stops; s++) {
            cellY[s] = (int) ((lat[s] - minLat) / cellLat);
            cellX[s] = (int) ((lon[s] - minLon) / cellLon);
            cells.computeIfAbsent(cell(cellY[s], cellX[s]), k -> new IntList(4)).add(s);
        }
        for (int a = 0; a < stops; a++) {
            for (int dy = -1; dy <= 1; dy++) {
                for (int dx = -1; dx <= 1; dx++) {
                    IntList others = cells.get(cell(cellY[a] + dy, cellX[a] + dx));
                    if (others == null) {
                        continue;
                    }
                    for (int i = 0; i < others.size; i++) {
                        int b = others.get(i);
                        if (b == a) {
                            continue;
                        }
                        double distance = metres(a, b);
                        if (distance <= radius) {
                            propose(a, b, settings.walkSecs(distance), NEARBY);
                        }
                    }
                }
            }
        }
    }

    private static long cell(int y, int x) {
        return ((long) y << 32) | (x & 0xffffffffL);
    }

    /**
     * Links every pair of stops that share a station, with a minimum time. Pairs further apart than
     * the station limit are taken to be a mistake in the feed and left to the distance rule.
     */
    void addStations(int[] station, int stationCount) {
        List<IntList> members = new ArrayList<>(stationCount);
        for (int i = 0; i < stationCount; i++) {
            members.add(null);
        }
        for (int s = 0; s < stops; s++) {
            if (station[s] >= 0) {
                IntList list = members.get(station[s]);
                if (list == null) {
                    list = new IntList(2);
                    members.set(station[s], list);
                }
                list.add(s);
            }
        }
        int tooFar = 0;
        for (IntList list : members) {
            if (list == null) {
                continue;
            }
            for (int i = 0; i < list.size; i++) {
                for (int j = 0; j < list.size; j++) {
                    if (i != j) {
                        int a = list.get(i);
                        int b = list.get(j);
                        double distance = metres(a, b);
                        if (distance > settings.stationMaxMetres()) {
                            tooFar++;
                            continue;
                        }
                        propose(a, b, Math.max(settings.stationMinSecs(), settings.walkSecs(distance)), STATION);
                    }
                }
            }
        }
        if (tooFar > 0) {
            notes.add(count(tooFar / 2) + " pairs of stops share a station but are more than "
                    + Math.round(settings.stationMaxMetres()) + " m apart, and were not linked as one");
        }
    }

    /**
     * Finds the quickest way through the pathways from each stop to every other stop. Most pathways
     * do not join two platforms directly; they pass through entrances and walkway points, which are
     * rows of stops.txt that no trip calls at.
     *
     * @param pathways  pathways.txt
     * @param rowOf     every row of stops.txt by id
     * @param stopOfRow the timetable's stop for a row of stops.txt, or -1
     */
    void addPathways(CsvReader pathways, Map<String, Integer> rowOf, int[] stopOfRow) throws IOException {
        int cFrom = pathways.require("from_stop_id");
        int cTo = pathways.require("to_stop_id");
        int cBoth = pathways.column("is_bidirectional");
        int cTime = pathways.column("traversal_time");

        Map<Integer, Integer> nodeOfRow = new HashMap<>();
        IntList rowOfNode = new IntList(1 << 10);
        List<IntList> edges = new ArrayList<>(); // per node: target, seconds, target, seconds, ...
        int unknown = 0;
        int untimed = 0;
        while (pathways.next()) {
            Integer a = rowOf.get(pathways.text(cFrom));
            Integer b = rowOf.get(pathways.text(cTo));
            if (a == null || b == null) {
                unknown++;
                continue;
            }
            int seconds = pathways.number(cTime, -1);
            if (seconds < 0) {
                seconds = settings.defaultPathwaySecs();
                untimed++;
            }
            int na = node(a, nodeOfRow, rowOfNode, edges);
            int nb = node(b, nodeOfRow, rowOfNode, edges);
            edges.get(na).add(nb);
            edges.get(na).add(seconds);
            if (pathways.number(cBoth, 0) == 1) {
                edges.get(nb).add(na);
                edges.get(nb).add(seconds);
            }
        }
        if (unknown > 0) {
            notes.add(count(unknown) + " pathways name a stop that is not in stops.txt and were left out");
        }
        if (untimed > 0) {
            notes.add(count(untimed) + " pathways give no time; " + settings.defaultPathwaySecs() + " s was assumed");
        }

        int nodes = rowOfNode.size;
        int[] best = new int[nodes];
        PriorityQueue<Long> queue = new PriorityQueue<>();
        for (int source = 0; source < nodes; source++) {
            int origin = stopOfRow[rowOfNode.get(source)];
            if (origin < 0) {
                continue;
            }
            Arrays.fill(best, Integer.MAX_VALUE);
            best[source] = 0;
            queue.clear();
            queue.add((long) source);
            while (!queue.isEmpty()) {
                long head = queue.poll();
                int node = (int) head;
                int time = (int) (head >>> 32);
                if (time > best[node]) {
                    continue;
                }
                int target = stopOfRow[rowOfNode.get(node)];
                if (target >= 0 && node != source) {
                    propose(origin, target, time, PATHWAY);
                }
                IntList out = edges.get(node);
                for (int i = 0; i < out.size; i += 2) {
                    int next = out.get(i);
                    int reached = time + out.get(i + 1);
                    if (reached < best[next] && reached <= settings.maxPathwaySecs()) {
                        best[next] = reached;
                        queue.add(((long) reached << 32) | next);
                    }
                }
            }
        }
    }

    private static int node(int row, Map<Integer, Integer> nodeOfRow, IntList rowOfNode, List<IntList> edges) {
        Integer node = nodeOfRow.get(row);
        if (node == null) {
            node = rowOfNode.size;
            nodeOfRow.put(row, node);
            rowOfNode.add(row);
            edges.add(new IntList(4));
        }
        return node;
    }

    /**
     * Applies the feed's own transfers.txt. A row with a minimum time sets the time; a row that
     * says "not possible" removes the link; any other row makes sure the link exists.
     */
    void addFeedTransfers(CsvReader transfers, Map<String, Integer> rowOf, int[] stopOfRow) throws IOException {
        int cFrom = transfers.require("from_stop_id");
        int cTo = transfers.require("to_stop_id");
        int cType = transfers.column("transfer_type");
        int cTime = transfers.column("min_transfer_time");
        int[] narrow = {transfers.column("from_route_id"), transfers.column("to_route_id"),
                transfers.column("from_trip_id"), transfers.column("to_trip_id")};
        int skipped = 0;
        int applied = 0;
        rows:
        while (transfers.next()) {
            for (int column : narrow) {
                if (!transfers.isEmpty(column)) {
                    skipped++; // applies only to one route or trip, which the router does not model
                    continue rows;
                }
            }
            Integer rowA = rowOf.get(transfers.text(cFrom));
            Integer rowB = rowOf.get(transfers.text(cTo));
            int a = rowA == null ? -1 : stopOfRow[rowA];
            int b = rowB == null ? -1 : stopOfRow[rowB];
            if (a < 0 || b < 0) {
                skipped++; // a station, or a stop no trip uses
                continue;
            }
            if (a == b) {
                continue; // changing at one stop is always possible and takes no time
            }
            int type = transfers.number(cType, 0);
            int time = transfers.number(cTime, -1);
            if (type == 3) {
                propose(a, b, FORBIDDEN, FEED);
            } else if (type == 2 && time >= 0) {
                propose(a, b, time, FEED);
            } else {
                propose(a, b, settings.walkSecs(metres(a, b)), FEED);
            }
            applied++;
        }
        if (applied > 0 || skipped > 0) {
            notes.add("transfers.txt: " + count(applied) + " rows used, " + count(skipped)
                    + " left out (they name a station, an unused stop, or a single route or trip)");
        }
    }

    /** Settles duplicates, applies the cap and lays the links out stop by stop, quickest first. */
    Result finish() {
        int proposed = from.size;
        int[] start = new int[stops + 1];
        for (int i = 0; i < proposed; i++) {
            start[from.get(i) + 1]++;
        }
        for (int s = 0; s < stops; s++) {
            start[s + 1] += start[s];
        }
        int[] byStop = new int[proposed];
        int[] next = start.clone();
        for (int i = 0; i < proposed; i++) {
            byStop[next[from.get(i)]++] = i;
        }

        int[] offset = new int[stops + 1];
        IntList targets = new IntList(Math.max(16, proposed / 2));
        IntList seconds = new IntList(Math.max(16, proposed / 2));
        IntList distances = new IntList(Math.max(16, proposed / 2));
        int[] kept = new int[KINDS];
        int capped = 0;
        long[] keys = new long[16];
        for (int a = 0; a < stops; a++) {
            int count = start[a + 1] - start[a];
            if (keys.length < count) {
                keys = new long[count * 2];
            }
            // By target, then by source, so the first of each target is the one that wins.
            for (int i = 0; i < count; i++) {
                int link = byStop[start[a] + i];
                keys[i] = ((long) to.get(link) << 34) | ((long) kind.get(link) << 32) | link;
            }
            Arrays.sort(keys, 0, count);
            int unique = 0;
            int lastTarget = -1;
            for (int i = 0; i < count; i++) {
                int link = (int) keys[i];
                if (to.get(link) == lastTarget) {
                    continue;
                }
                lastTarget = to.get(link);
                if (secs.get(link) != FORBIDDEN) {
                    // Stated links first, then quickest first, for the cap.
                    long generated = kind.get(link) >= STATION ? 1 : 0;
                    keys[unique++] = (generated << 62) | ((long) secs.get(link) << 32) | link;
                }
            }
            Arrays.sort(keys, 0, unique);
            int chosen = 0;
            for (int i = 0; i < unique; i++) {
                int link = (int) keys[i];
                if (kind.get(link) >= STATION && chosen >= settings.maxPerStop()) {
                    capped++;
                    continue;
                }
                keys[chosen++] = ((long) secs.get(link) << 32) | link;
            }
            Arrays.sort(keys, 0, chosen);
            for (int i = 0; i < chosen; i++) {
                int link = (int) keys[i];
                targets.add(to.get(link));
                seconds.add(secs.get(link));
                distances.add((int) Math.round(metres(a, to.get(link))));
                kept[kind.get(link)]++;
            }
            offset[a + 1] = targets.size;
        }
        notes.add("walking links: " + count(kept[PATHWAY]) + " through station pathways, "
                + count(kept[STATION]) + " between stops of one station, " + count(kept[NEARBY])
                + " between stops within " + Math.round(settings.radiusMetres()) + " m, "
                + count(kept[FEED]) + " from transfers.txt");
        if (capped > 0) {
            notes.add(count(capped) + " walking links were left out by the limit of "
                    + settings.maxPerStop() + " per stop");
        }
        return new Result(offset, targets.toArray(), seconds.toArray(), distances.toArray(), notes);
    }

    private static String count(int number) {
        return String.format("%,d", number);
    }
}
