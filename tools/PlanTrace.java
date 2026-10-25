import cwlib.resources.RPlan;
import cwlib.singleton.ResourceSystem;
import cwlib.types.SerializedResource;

/**
 * Every part boundary of a plan's Things as cwlib reads its `thingData` -- what
 * `CwlibTrace spans` gives for a level, for a plan, whose Things cwlib only
 * parses when asked (`RPlan.getThings`). The offsets are in the `thingData`
 * stream, as `readPlan`'s own trace is (`../cwlib-ts/dev/span-diff.ts`).
 *
 *   "$JDK/java" -cp "$JAR;out" PlanTrace <plan>
 *
 * Built and run as `CwlibTrace` is; the trace goes to stderr.
 */
public class PlanTrace {
    public static void main(String[] args) throws Exception {
        SerializedResource sr = new SerializedResource(args[0]);
        RPlan plan = sr.loadResource(RPlan.class);
        ResourceSystem.LOG_LEVEL = ResourceSystem.ResourceLogLevel.SERIALIZER_TRACE;
        try { plan.getThings(); } catch (Throwable t) { System.out.println("# " + t); }
    }
}
