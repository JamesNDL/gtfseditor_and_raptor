package gtfseditor.router.sim;

import gtfseditor.router.core.Query;
import gtfseditor.router.core.Router;
import java.util.Properties;

/**
 * The settings of a run. The defaults are the owner's, from section 4.6 and section 7.1 of
 * docs/simulator-plan.md. Set the fields, then hand the settings to a run; a run does not change
 * them.
 */
public final class SimSettings {

    /** How far people will walk to another stop, in a straight line. At 0 nobody changes stop. */
    public double walkMetres = 500;
    /** How much sooner a journey with one more vehicle must arrive to be taken. */
    public int changePenaltySecs = 600;
    /** How much better another stop must be, beyond a person's margin, before they change to it. */
    public int switchThresholdSecs = 600;
    /** How much later than on the published timetable a person accepts arriving; -1 for no limit. */
    public int giveUpSecs = 3600;
    /**
     * The longest a person will wait in all, before setting off and between vehicles; -1 for no
     * limit. A journey that needs more is not one they make: they count as having no journey. Four
     * hours unless said: without it, someone who turns up after the last service of the morning
     * "travels" by waiting for the evening one.
     */
    public int maxWaitSecs = 4 * 3600;
    /** Whether school buses may be ridden. */
    public boolean schoolBuses = false;
    /** Simulate one row in this many, each standing for this many times its people. */
    public int shareOneIn = 1;
    /** Only journeys that start and end in this box, or null for all of them. */
    public Area area = null;

    /** Whether a full vehicle leaves people behind. Off, everyone takes their planned journey. */
    public boolean capacity = false;
    /** The share of its capacity at which a vehicle counts as full. */
    public double fullAt = 1.0;
    /** A person left behind more often than this is stranded. */
    public int maxLeftBehind = 5;

    public int maxRides = Router.DEFAULT_MAX_RIDES;
    /** Least time to change vehicles at one stop. */
    public int changeSecs = Query.DEFAULT_CHANGE_SECS;
    public int threads = Math.max(1, Runtime.getRuntime().availableProcessors() - 2);
    /** Whether one search serves everyone it fits (section 5.2). Off only to measure what it saves. */
    public boolean reusePlans = true;

    public SimSettings copy() {
        SimSettings s = new SimSettings();
        s.walkMetres = walkMetres;
        s.changePenaltySecs = changePenaltySecs;
        s.switchThresholdSecs = switchThresholdSecs;
        s.giveUpSecs = giveUpSecs;
        s.maxWaitSecs = maxWaitSecs;
        s.schoolBuses = schoolBuses;
        s.shareOneIn = shareOneIn;
        s.area = area;
        s.capacity = capacity;
        s.fullAt = fullAt;
        s.maxLeftBehind = maxLeftBehind;
        s.maxRides = maxRides;
        s.changeSecs = changeSecs;
        s.threads = threads;
        s.reusePlans = reusePlans;
        return s;
    }

    /** @throws IllegalArgumentException if a setting is outside the range the plan gives it */
    public void check() {
        if (!(walkMetres >= 0 && walkMetres <= 2000)) {
            throw new IllegalArgumentException("the walk to another stop is 0 to 2,000 m");
        }
        if (changePenaltySecs < 0 || changePenaltySecs > 1800 || switchThresholdSecs < 0 || switchThresholdSecs > 1800) {
            throw new IllegalArgumentException("the time a change of vehicle or of stop must save is 0 to 30 minutes");
        }
        if (giveUpSecs != -1 && giveUpSecs < 600) {
            throw new IllegalArgumentException("the give-up limit is 10 minutes or more, or none");
        }
        if (maxWaitSecs != -1 && maxWaitSecs < 600) {
            throw new IllegalArgumentException("the longest wait is 10 minutes or more, or none");
        }
        if (shareOneIn < 1 || maxLeftBehind < 0 || threads < 1 || maxRides < 1 || changeSecs < 0) {
            throw new IllegalArgumentException("a setting is below its lowest value");
        }
        if (!(fullAt > 0 && fullAt <= 10)) {
            throw new IllegalArgumentException("fullAt must be above 0, and is usually 1");
        }
    }

    /**
     * The settings a scenario run must share with the BAU run it is measured against (section 6.4):
     * they decide the plans, and so each person's margin.
     */
    void writeShared(Properties into) {
        into.setProperty("walkMetres", Double.toString(walkMetres));
        into.setProperty("changePenaltySecs", Integer.toString(changePenaltySecs));
        into.setProperty("schoolBuses", Boolean.toString(schoolBuses));
        into.setProperty("shareOneIn", Integer.toString(shareOneIn));
        into.setProperty("area", area == null ? "all" : area.text());
        into.setProperty("maxRides", Integer.toString(maxRides));
        into.setProperty("changeSecs", Integer.toString(changeSecs));
        into.setProperty("maxWaitSecs", Integer.toString(maxWaitSecs));
    }

    void readShared(Properties from) {
        walkMetres = Double.parseDouble(from.getProperty("walkMetres"));
        changePenaltySecs = Integer.parseInt(from.getProperty("changePenaltySecs"));
        schoolBuses = Boolean.parseBoolean(from.getProperty("schoolBuses"));
        shareOneIn = Integer.parseInt(from.getProperty("shareOneIn"));
        area = Area.parse(from.getProperty("area"));
        maxRides = Integer.parseInt(from.getProperty("maxRides"));
        changeSecs = Integer.parseInt(from.getProperty("changeSecs"));
        // A run made before there was a limit had none, and the runs made from it must match it.
        maxWaitSecs = Integer.parseInt(from.getProperty("maxWaitSecs", "-1"));
    }

    /** The settings a scenario run chooses for itself. */
    void writeOwn(Properties into) {
        into.setProperty("switchThresholdSecs", Integer.toString(switchThresholdSecs));
        into.setProperty("giveUpSecs", Integer.toString(giveUpSecs));
        into.setProperty("capacity", Boolean.toString(capacity));
        into.setProperty("fullAt", Double.toString(fullAt));
        into.setProperty("maxLeftBehind", Integer.toString(maxLeftBehind));
    }

    void readOwn(Properties from) {
        switchThresholdSecs = Integer.parseInt(from.getProperty("switchThresholdSecs"));
        giveUpSecs = Integer.parseInt(from.getProperty("giveUpSecs"));
    }
}
