package gtfseditor.router.server;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import gtfseditor.router.road.LatLon;
import gtfseditor.router.road.RoadRoute;
import java.util.ArrayList;
import java.util.List;

/**
 * Reading and writing the JSON of the road endpoints (architecture §3.3): points as
 * {@code {"lat", "lon"}}, the profile, and numbers rounded for the answer, with {@code null} for
 * none (no way, or no road nearby).
 */
final class RoadJson {

    /** The one profile offered. */
    static final String CAR = "car";

    private static final JsonNodeFactory JSON = JsonNodeFactory.instance;

    private RoadJson() {}

    /** Refuses a profile other than car; left out means car. */
    static void checkProfile(JsonNode profile) {
        if (profile != null && !profile.isNull() && !(profile.isTextual() && CAR.equals(profile.asText()))) {
            throw ApiException.bad("profile must be \"car\"; no other is offered, not " + profile);
        }
    }

    /**
     * Reads one point, {@code {"lat": .., "lon": ..}}, in WGS84 degrees.
     *
     * @param name what the point is called in the request, for the error
     */
    static LatLon point(JsonNode node, String name) {
        if (node == null || !node.isObject() || !node.path("lat").isNumber() || !node.path("lon").isNumber()) {
            throw ApiException.bad(name + " must be a point, {\"lat\": .., \"lon\": ..} with two numbers");
        }
        double lat = node.get("lat").asDouble();
        double lon = node.get("lon").asDouble();
        if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180)) {
            throw ApiException.bad(name + " is not a place on the globe: lat must be -90 to 90 and lon -180 to 180");
        }
        return new LatLon(lat, lon);
    }

    /**
     * Reads a list of points.
     *
     * @param mayBeEmpty whether an empty list is allowed (via points) or not (sources, destinations)
     */
    static List<LatLon> points(JsonNode node, String name, boolean mayBeEmpty) {
        if (node == null || !node.isArray()) {
            throw ApiException.bad(name + " must be a list of points, [{\"lat\": .., \"lon\": ..}, ..]");
        }
        if (node.isEmpty() && !mayBeEmpty) {
            throw ApiException.bad(name + " must hold at least one point");
        }
        List<LatLon> points = new ArrayList<>(node.size());
        for (int i = 0; i < node.size(); i++) {
            points.add(point(node.get(i), name + "[" + i + "]"));
        }
        return points;
    }

    /** The status as the answer names it: {@code ok}, {@code noRoute} or {@code noRoad}. */
    static String status(RoadRoute.Status status) {
        return switch (status) {
            case OK -> "ok";
            case NO_ROUTE -> "noRoute";
            case NO_ROAD -> "noRoad";
        };
    }

    /** Puts a number rounded to a tenth, or {@code null} for NaN. */
    static void putRounded(ObjectNode node, String name, double value) {
        if (Double.isNaN(value)) {
            node.putNull(name);
        } else {
            node.put(name, tenths(value));
        }
    }

    /** A list of numbers rounded to a tenth, {@code null} for NaN. */
    static ArrayNode row(double[] values) {
        ArrayNode row = JSON.arrayNode(values.length);
        for (double value : values) {
            if (Double.isNaN(value)) {
                row.addNull();
            } else {
                row.add(tenths(value));
            }
        }
        return row;
    }

    /** Rows of numbers: one row per source. */
    static ArrayNode grid(double[][] values) {
        ArrayNode grid = JSON.arrayNode(values.length);
        for (double[] sourceRow : values) {
            grid.add(row(sourceRow));
        }
        return grid;
    }

    /** A line as {@code [lon, lat]} pairs, to six places (about 0.1 m). */
    static ArrayNode line(double[][] lonLats) {
        ArrayNode line = JSON.arrayNode(lonLats.length);
        for (double[] lonLat : lonLats) {
            line.addArray().add(Math.round(lonLat[0] * 1e6) / 1e6).add(Math.round(lonLat[1] * 1e6) / 1e6);
        }
        return line;
    }

    private static double tenths(double value) {
        return Math.round(value * 10) / 10.0;
    }
}
