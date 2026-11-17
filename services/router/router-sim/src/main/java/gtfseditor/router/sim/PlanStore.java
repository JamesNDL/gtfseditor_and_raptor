package gtfseditor.router.sim;

import gtfseditor.router.core.Journey;
import gtfseditor.router.core.Leg;
import gtfseditor.router.core.Timetable;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.GZIPInputStream;
import java.util.zip.GZIPOutputStream;

/**
 * Keeps the plans of a run in a file, so that capacity can be switched on later without planning
 * again, and so that a scenario run can take its reference from a BAU run. See sections 4.5 and
 * 5.1 of docs/simulator-plan.md.
 *
 * <p>The journeys in the file name trips and stops by their numbers in the timetable they were
 * planned on, so they can only be read back for that timetable; {@link #fingerprint} tells. The
 * figures a reference needs (status, arrival, margin) hold for any timetable.
 */
final class PlanStore {

    private static final int MAGIC = 0x53504c4e; // "SPLN"
    private static final int FORMAT = 1;
    private static final Leg.Kind[] KINDS = Leg.Kind.values();

    private PlanStore() {}

    /** A number that differs between two timetables with different stops, trips, times or links. */
    static long fingerprint(Timetable t) {
        long h = 1125899906842597L;
        h = 31 * h + t.serviceDate;
        for (String id : t.stopIds) {
            h = 31 * h + id.hashCode();
        }
        for (String id : t.tripIds) {
            h = 31 * h + id.hashCode();
        }
        for (int[] array : new int[][] {t.patternStopOffset, t.patternTripOffset, t.patternStops, t.arrive, t.depart,
                t.tripStayAboard, t.transferOffset, t.transferTargets, t.transferSecs}) {
            h = 31 * h + array.length;
            for (int value : array) {
                h = 31 * h + value;
            }
        }
        for (byte flags : t.patternStopFlags) {
            h = 31 * h + flags;
        }
        return h;
    }

    static void write(Path file, Plans plans, long fingerprint) throws IOException {
        Map<Journey, Integer> numbers = new IdentityHashMap<>();
        List<Journey> journeys = new ArrayList<>();
        for (Journey journey : plans.journey) {
            if (journey != null && numbers.putIfAbsent(journey, journeys.size()) == null) {
                journeys.add(journey);
            }
        }
        try (DataOutputStream out = new DataOutputStream(new BufferedOutputStream(
                new GZIPOutputStream(Files.newOutputStream(file), 1 << 16), 1 << 16))) {
            out.writeInt(MAGIC);
            out.writeInt(FORMAT);
            out.writeLong(fingerprint);
            out.writeInt(plans.size());
            out.writeInt(journeys.size());
            for (Journey journey : journeys) {
                out.writeUTF(journey.label());
                out.writeInt(journey.depart());
                out.writeInt(journey.arrive());
                out.writeInt(journey.rides());
                out.writeInt(journey.changes());
                out.writeInt(journey.walkSecs());
                out.writeInt(journey.waitSecs());
                out.writeShort(journey.legs().size());
                for (Leg leg : journey.legs()) {
                    out.writeByte(leg.kind().ordinal() | (leg.stayAboard() ? 0x80 : 0));
                    out.writeInt(leg.fromStop());
                    out.writeInt(leg.toStop());
                    out.writeInt(leg.depart());
                    out.writeInt(leg.arrive());
                    out.writeInt(leg.metres());
                    out.writeInt(leg.trip());
                    out.writeInt(leg.boardPosition());
                    out.writeInt(leg.alightPosition());
                }
            }
            for (int row = 0; row < plans.size(); row++) {
                out.writeByte(plans.status[row]);
                out.writeBoolean(plans.near[row]);
                out.writeByte(plans.reason[row]);
                out.writeByte(plans.why[row]);
                out.writeInt(plans.arrive[row]);
                out.writeInt(plans.margin[row]);
                out.writeInt(plans.ownArrive[row]);
                out.writeInt(plans.ownCost[row]);
                out.writeInt(plans.nearArrive[row]);
                out.writeInt(plans.nearCost[row]);
                out.writeInt(plans.journey[row] == null ? -1 : numbers.get(plans.journey[row]));
            }
        }
    }

    /**
     * Reads plans back.
     *
     * @param fingerprint the fingerprint of the timetable the journeys are wanted for, or null to
     *                    read only the figures a reference needs and leave every journey null
     * @throws IllegalArgumentException if the journeys are wanted and the file was written for
     *                                  another timetable
     */
    static Plans read(Path file, Long fingerprint) throws IOException {
        try (DataInputStream in = new DataInputStream(new BufferedInputStream(
                new GZIPInputStream(Files.newInputStream(file), 1 << 16), 1 << 16))) {
            if (in.readInt() != MAGIC || in.readInt() != FORMAT) {
                throw new IOException(file + " is not a file of kept plans this version can read");
            }
            long written = in.readLong();
            if (fingerprint != null && fingerprint != written) {
                throw new IllegalArgumentException("the plans in " + file + " were made on a different timetable; "
                        + "capacity can only be added on the timetable a run was planned on");
            }
            Plans plans = new Plans(in.readInt());
            Journey[] journeys = new Journey[in.readInt()];
            for (int j = 0; j < journeys.length; j++) {
                String label = in.readUTF();
                int depart = in.readInt();
                int arrive = in.readInt();
                int rides = in.readInt();
                int changes = in.readInt();
                int walkSecs = in.readInt();
                int waitSecs = in.readInt();
                int count = in.readUnsignedShort();
                List<Leg> legs = new ArrayList<>(count);
                for (int i = 0; i < count; i++) {
                    int kind = in.readUnsignedByte();
                    legs.add(new Leg(KINDS[kind & 0x7f], in.readInt(), in.readInt(), in.readInt(), in.readInt(),
                            in.readInt(), in.readInt(), in.readInt(), in.readInt(), (kind & 0x80) != 0));
                }
                journeys[j] = fingerprint == null ? null
                        : new Journey(label, depart, arrive, rides, changes, walkSecs, waitSecs, legs);
            }
            for (int row = 0; row < plans.size(); row++) {
                plans.status[row] = in.readByte();
                plans.near[row] = in.readBoolean();
                plans.reason[row] = in.readByte();
                plans.why[row] = in.readByte();
                plans.arrive[row] = in.readInt();
                plans.margin[row] = in.readInt();
                plans.ownArrive[row] = in.readInt();
                plans.ownCost[row] = in.readInt();
                plans.nearArrive[row] = in.readInt();
                plans.nearCost[row] = in.readInt();
                int journey = in.readInt();
                plans.journey[row] = journey < 0 ? null : journeys[journey];
            }
            return plans;
        }
    }
}
