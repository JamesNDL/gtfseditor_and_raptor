package gtfseditor.router.core;

/** Where a journey starts or ends: one stop, every stop of a station, or a point on the map. */
public sealed interface Place {

    /** @param stop the stop's number in the timetable */
    record Stop(int stop) implements Place {}

    /** @param station the station's number in the timetable; any of its stops will do */
    record Station(int station) implements Place {}

    record Point(double lat, double lon) implements Place {}
}
