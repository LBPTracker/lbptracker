import cwlib.enums.Part;
import cwlib.resources.RLevel;
import cwlib.singleton.ResourceSystem;
import cwlib.structs.things.Thing;
import cwlib.structs.things.parts.PWorld;
import cwlib.types.SerializedResource;
import cwlib.types.data.WrappedResource;

import java.io.File;

/**
 * Ask cwlib what it reads from a level, and WHERE -- the reference reading, with
 * byte offsets, to diff `packages/cwlib-ts/src/thing.ts`'s own trace against.
 *
 * ❗ **This is the tool question 28 needed and did not have.** That entry spent a
 * session on a byte-level trace and another guessing at gates. cwlib's serialiser
 * already logs every part boundary with its offset; turning that on takes one
 * static field, and the result is a per-part span table that turns "something
 * before byte 287 is wrong" into "SHAPE ran 121..248 and cwlib ran it 121..233".
 *
 * Two modes:
 *
 *   java -cp "$JAR;out" CwlibTrace parts  <level> ...   thing counts and part lists
 *   java -cp "$JAR;out" CwlibTrace spans  <level>       every part boundary, with offsets
 *
 * Build it the way the other Java tools here are built -- ⚠️ and note the two
 * runtimes on this machine differ: `javac` is JDK 25 and the `java` first on PATH
 * is 1.8, which fails with `UnsupportedClassVersionError`. Use the JDK's own:
 *
 *   JAR=C:\Users\sgdc3\Desktop\LBP\toolkit\tools\sequencerdump\target\sequencerdump-0.1.jar
 *   JDK="C:\Program Files\Eclipse Adoptium\jdk-25.0.3.9-hotspot\bin"
 *   javac -cp "$JAR" -d out tools/CwlibTrace.java
 *   "$JDK/java" -cp "$JAR;out" CwlibTrace spans fixtures/archive/0-c33a7e*
 *
 * ⚠️ **cwlib is somebody's reading of the game, not the game** -- *Provenance
 * rule 1* in `../cwlib-ts/steering/lbp-modding-toolchain.md` still applies. What makes it
 * usable here is that it is a reading which *demonstrably parses these files*:
 * every LBP1 level in `fixtures/archive` that this project refuses, cwlib reads,
 * with a thing count. That is a fact about the files, and a disagreement between
 * the two traces is therefore ours to explain.
 */
public class CwlibTrace {
    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.out.println("usage: CwlibTrace parts|spans <level> ...");
            return;
        }
        boolean spans = args[0].equals("spans");
        if (spans) ResourceSystem.LOG_LEVEL = ResourceSystem.ResourceLogLevel.SERIALIZER_TRACE;

        for (int i = 1; i < args.length; i++) {
            String path = args[i];
            String name = new File(path).getName();
            if (name.length() > 10) name = name.substring(0, 10);
            try {
                SerializedResource sr = new SerializedResource(path);
                Object loaded = new WrappedResource(sr).resource;
                if (spans) continue; // the interesting output already went to stdout
                if (!(loaded instanceof RLevel)) {
                    System.out.printf("%s  -> not an RLevel: %s%n", name,
                        loaded.getClass().getSimpleName());
                    continue;
                }
                RLevel level = (RLevel) loaded;
                PWorld world = level.worldThing.getPart(Part.WORLD);
                int total = world == null ? -1 : world.things.size();
                int live = 0;
                if (world != null)
                    for (Thing t : world.things) if (t != null) live++;
                // ⚠️ The list holds nulls: `packages/cwlib-ts/src/level.ts` filters them out, so
                // compare the NON-NULL count against what the walk reports.
                System.out.printf("%s  v%x/%x branch %x/%x  -> %d things (%d non-null)%n", name,
                    sr.getRevision().getVersion(), sr.getRevision().getSubVersion(),
                    sr.getRevision().getBranchID(), sr.getRevision().getBranchRevision(),
                    total, live);
                for (int k = 0; k < 3 && world != null && k < world.things.size(); k++)
                    dump("  [" + k + "]", world.things.get(k));
            } catch (Throwable t) {
                System.out.printf("%s  -> %s: %s%n", name, t.getClass().getSimpleName(),
                    String.valueOf(t.getMessage()).replace('\n', ' '));
            }
        }
    }

    /** One Thing's identity and the parts it actually carries, which is the mask decoded. */
    private static void dump(String tag, Thing t) {
        if (t == null) {
            System.out.printf("%s: null%n", tag);
            return;
        }
        StringBuilder parts = new StringBuilder();
        for (Part p : Part.values())
            if (t.getPart(p) != null) parts.append(p.name()).append(' ');
        System.out.printf("%s UID=%d parent=%s planGUID=%s%n      parts: %s%n", tag, t.UID,
            t.parent == null ? "null" : String.valueOf(t.parent.UID),
            String.valueOf(t.planGUID), parts);
    }
}
