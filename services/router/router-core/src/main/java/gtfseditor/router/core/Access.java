package gtfseditor.router.core;

/**
 * A walk between the start or end of a journey and a stop.
 *
 * @param stop   the stop's number in the timetable
 * @param secs   walking time; 0 when the journey starts or ends at the stop itself
 * @param metres straight-line distance
 */
public record Access(int stop, int secs, int metres) {

    public Access {
        if (stop < 0 || secs < 0 || metres < 0) {
            throw new IllegalArgumentException("a walk to or from a stop cannot be negative");
        }
    }
}
