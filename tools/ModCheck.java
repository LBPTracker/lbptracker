import cwlib.types.databases.FileDBRow;
import cwlib.types.mods.Mod;

import java.io.File;
import java.nio.file.Files;
import java.nio.file.Paths;

/**
 * The check on `packages/cwlib-ts/src/archives/mod.ts`: cwlib is the `.mod` format's only
 * definition, so the proof of our writer is that `cwlib.types.mods.Mod` opens
 * what it wrote, and the proof of our reader is that it opens what `Mod.save`
 * wrote.
 *
 * Build and run (JDK 25's `java`, see steering/tools.md):
 *
 *   javac -cp "$JAR" -d out tools/ModCheck.java
 *   java  -cp "$JAR;out" ModCheck read  <in.mod>              config + one line per row
 *   java  -cp "$JAR;out" ModCheck write <out.mod> <path> <file> [guid]
 *
 * `read` prints each row's path, GUID, size, SHA-1 and whether the archive
 * really holds bytes of that size under that hash.
 */
public class ModCheck {
    public static void main(String[] args) throws Exception {
        if (args.length >= 2 && args[0].equals("read")) {
            Mod mod = new Mod(new File(args[1]));
            System.out.printf("id=%s type=%s title=%s version=%s author=%s%n",
                mod.getConfig().ID, mod.getConfig().type, mod.getConfig().title,
                mod.getConfig().version, mod.getConfig().author);
            for (FileDBRow row : mod) {
                byte[] data = mod.extract(row.getSHA1());
                System.out.printf("%s g%d size=%d sha1=%s held=%s%n",
                    row.getPath(), row.getGUID().getValue(), row.getSize(), row.getSHA1(),
                    data != null && data.length == row.getSize());
            }
        } else if (args.length >= 4 && args[0].equals("write")) {
            Mod mod = new Mod();
            mod.getConfig().title = "written by cwlib";
            byte[] data = Files.readAllBytes(Paths.get(args[3]));
            if (args.length > 4) mod.add(args[2], data, new cwlib.types.data.GUID(Long.parseLong(args[4])));
            else mod.add(args[2], data);
            mod.save(new File(args[1]));
        } else {
            System.err.println("usage: ModCheck read <in.mod> | write <out.mod> <path> <file> [guid]");
        }
    }
}
