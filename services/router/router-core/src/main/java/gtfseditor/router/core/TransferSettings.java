package gtfseditor.router.core;

/**
 * The assumptions used to generate walking links between stops. See section 6.3 of
 * docs/router-plan.md. None of these figures is sourced; they are settings.
 *
 * @param radiusMetres       stops this close in a straight line are linked
 * @param walkMetresPerSec   walking speed
 * @param detourFactor       how much longer the walk is than the straight line
 * @param fixedSecs          time added to every generated walk
 * @param stationMinSecs     shortest walk between two stops of one station that has no pathways
 * @param stationMaxMetres   stops of one station further apart than this are not linked; a larger
 *                           gap is taken to be a mistake in the feed
 * @param maxPerStop         most links kept per stop; links the feed states itself are always kept
 * @param defaultPathwaySecs time for a pathway that gives none
 * @param maxPathwaySecs     walks through a station longer than this are not offered
 * @param platformSecs       time between a railway platform and the street where the feed has no
 *                           pathways for it, added to walks between the platform and anywhere
 *                           outside its station
 */
public record TransferSettings(
        double radiusMetres,
        double walkMetresPerSec,
        double detourFactor,
        int fixedSecs,
        int stationMinSecs,
        double stationMaxMetres,
        int maxPerStop,
        int defaultPathwaySecs,
        int maxPathwaySecs,
        int platformSecs) {

    public TransferSettings {
        if (!(radiusMetres >= 0) || !(walkMetresPerSec > 0) || !(detourFactor >= 1) || !(stationMaxMetres >= 0)) {
            throw new IllegalArgumentException("transfer radius, walking speed or detour factor is out of range");
        }
        if (fixedSecs < 0 || stationMinSecs < 0 || maxPerStop < 0 || defaultPathwaySecs < 0 || maxPathwaySecs < 0
                || platformSecs < 0) {
            throw new IllegalArgumentException("transfer settings cannot be negative");
        }
    }

    /**
     * 500 m, 1.03 m/s, detour 1.3, plus 30 s; inside a station 60 s minimum and 1 km at most; 150
     * links per stop; 60 s between a railway platform without pathways and the street. The pace is the TfNSW trip planner's (the median of 2,661 of its walks), and
     * the 500 m, with the detour, is about the longest walk between stops it offered (670 m). See
     * section 18 of docs/router-plan.md.
     */
    public static TransferSettings defaults() {
        return new TransferSettings(500, 1.03, 1.3, 30, 60, 1000, 150, 60, 900, 60);
    }

    public TransferSettings withRadiusMetres(double metres) {
        return new TransferSettings(metres, walkMetresPerSec, detourFactor, fixedSecs, stationMinSecs,
                stationMaxMetres, maxPerStop, defaultPathwaySecs, maxPathwaySecs, platformSecs);
    }

    public TransferSettings withMaxPerStop(int links) {
        return new TransferSettings(radiusMetres, walkMetresPerSec, detourFactor, fixedSecs, stationMinSecs,
                stationMaxMetres, links, defaultPathwaySecs, maxPathwaySecs, platformSecs);
    }

    /** Seconds to walk between two points this far apart in a straight line. */
    public int walkSecs(double straightLineMetres) {
        return (int) Math.ceil(straightLineMetres * detourFactor / walkMetresPerSec) + fixedSecs;
    }
}
