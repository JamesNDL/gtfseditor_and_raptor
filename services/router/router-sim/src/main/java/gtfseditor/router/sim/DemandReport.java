package gtfseditor.router.sim;

import java.io.PrintStream;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * What came of reading and checking a demand file: how many rows there were, which were refused
 * and why, and a few figures about the rest. See section 3.2 of docs/simulator-plan.md.
 */
public final class DemandReport {

    private static final int EXAMPLES = 12;

    private long rowsRead;
    private final Map<String, Integer> refused = new LinkedHashMap<>();
    private final List<String> examples = new ArrayList<>();
    private long leftOutOutside;
    private long leftOutOneEnd;

    void read() {
        rowsRead++;
    }

    /** Notes one refused row. */
    void refuse(String reason, String example) {
        refused.merge(reason, 1, Integer::sum);
        if (examples.size() < EXAMPLES) {
            examples.add(example + ": " + reason);
        }
    }

    void leftOut(boolean oneEndInside) {
        if (oneEndInside) {
            leftOutOneEnd++;
        } else {
            leftOutOutside++;
        }
    }

    /** Rows in the file, not counting the header or blank lines. */
    public long rowsRead() {
        return rowsRead;
    }

    public long rowsRefused() {
        long total = 0;
        for (int count : refused.values()) {
            total += count;
        }
        return total;
    }

    /** Each reason for refusing a row and how many rows it refused. */
    public Map<String, Integer> refused() {
        return Collections.unmodifiableMap(refused);
    }

    /** The first few refused rows, in words. */
    public List<String> examples() {
        return Collections.unmodifiableList(examples);
    }

    /** Rows left out by a run's area because both ends are outside it. */
    public long leftOutOutside() {
        return leftOutOutside;
    }

    /** Rows left out by a run's area because only one end is inside it. */
    public long leftOutOneEnd() {
        return leftOutOneEnd;
    }

    /** Figures about the rows that were kept. */
    public record Figures(int rows, long people, int users, int earliest, int latest, int busiestHour,
            long busiestHourPeople) {}

    public static Figures figures(Demand demand) {
        int earliest = Integer.MAX_VALUE;
        int latest = -1;
        long[] byHour = new long[DemandReader.LATEST_START / 3600 + 1];
        for (int row = 0; row < demand.size(); row++) {
            earliest = Math.min(earliest, demand.start[row]);
            latest = Math.max(latest, demand.start[row]);
            byHour[demand.start[row] / 3600] += demand.people[row];
        }
        int busiest = 0;
        for (int hour = 1; hour < byHour.length; hour++) {
            if (byHour[hour] > byHour[busiest]) {
                busiest = hour;
            }
        }
        return new Figures(demand.size(), demand.totalPeople(), demand.userCount(),
                demand.size() == 0 ? -1 : earliest, latest, busiest, byHour[busiest]);
    }

    public void print(PrintStream out, Demand demand) {
        Figures f = figures(demand);
        out.printf("  rows read            %,d%n", rowsRead);
        out.printf("  rows refused         %,d%n", rowsRefused());
        refused.forEach((reason, count) -> out.printf("    %,9d  %s%n", count, reason));
        for (String example : examples) {
            out.println("      " + example);
        }
        if (leftOutOutside + leftOutOneEnd > 0) {
            out.printf("  left out by the area %,d wholly outside, %,d with one end inside%n", leftOutOutside,
                    leftOutOneEnd);
        }
        out.printf("  rows kept            %,d, standing for %,d people; %,d users%n", f.rows(), f.people(), f.users());
        if (f.rows() > 0) {
            out.printf("  first and last start %s to %s%n", Clock.text(f.earliest()), Clock.text(f.latest()));
            out.printf("  busiest hour         %02d:00, %,d people%n", f.busiestHour(), f.busiestHourPeople());
        }
    }
}
