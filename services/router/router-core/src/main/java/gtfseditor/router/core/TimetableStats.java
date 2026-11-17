package gtfseditor.router.core;

/**
 * Counts that describe a loaded timetable, for the metadata endpoint and the load report.
 *
 * @param firstDeparture       earliest departure of the day, in seconds
 * @param lastArrival          latest arrival, in seconds; past 86,400 means after midnight
 * @param longestPattern       most stops in one pattern
 * @param stayAboardLinks      trips whose passengers may stay aboard for the next trip
 * @param placeholderCapacity  trips whose capacity is a placeholder figure
 * @param defaultedCapacity    trips with no vehicle in the feed, given their mode's default
 * @param mostTransfersAtAStop the largest number of walking links any one stop has
 * @param estimatedBytes       rough memory taken by the timetable
 */
public record TimetableStats(
        int stations,
        int stops,
        int routes,
        int patterns,
        int patternStops,
        int trips,
        int stopTimes,
        int transfers,
        int firstDeparture,
        int lastArrival,
        int longestPattern,
        int stayAboardLinks,
        int placeholderCapacity,
        int defaultedCapacity,
        int mostTransfersAtAStop,
        long estimatedBytes) {

    public static TimetableStats of(Timetable t) {
        int first = Integer.MAX_VALUE;
        int last = Integer.MIN_VALUE;
        for (int time : t.depart) {
            first = Math.min(first, time);
        }
        for (int time : t.arrive) {
            last = Math.max(last, time);
        }
        int longest = 0;
        for (int p = 0; p < t.patternCount(); p++) {
            longest = Math.max(longest, t.patternLength(p));
        }
        int stayAboard = 0;
        int placeholder = 0;
        int defaulted = 0;
        for (int trip = 0; trip < t.tripCount(); trip++) {
            if (t.tripStayAboard[trip] >= 0) {
                stayAboard++;
            }
            if ((t.tripCapacityFlags[trip] & Timetable.CAPACITY_PLACEHOLDER) != 0) {
                placeholder++;
            }
            if ((t.tripCapacityFlags[trip] & Timetable.CAPACITY_DEFAULTED) != 0) {
                defaulted++;
            }
        }
        int most = 0;
        for (int s = 0; s < t.stopCount(); s++) {
            most = Math.max(most, t.transferOffset[s + 1] - t.transferOffset[s]);
        }
        return new TimetableStats(t.stationCount(), t.stopCount(), t.routeCount(), t.patternCount(),
                t.patternStops.length, t.tripCount(), t.stopTimeCount(), t.transferCount(),
                t.tripCount() == 0 ? 0 : first, t.tripCount() == 0 ? 0 : last, longest, stayAboard,
                placeholder, defaulted, most, t.estimatedBytes());
    }
}
