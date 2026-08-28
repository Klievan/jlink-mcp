import * as fs from "fs";
import * as path from "path";

/**
 * The version this build actually is, read from package.json.
 *
 * It used to be a literal in the McpServer constructor, and it said 0.3.2
 * while the package was 0.6.0 — three releases stale. Every client that
 * connected, every registry that scraped us, and every bug report anyone
 * filed carried the wrong number, and nothing could notice because a literal
 * is always internally consistent.
 *
 * Resolved by walking up from this file rather than by a fixed relative path,
 * because the same code runs from three different layouts: a repo checkout,
 * node_modules/jlink-mcp/, and extension/ inside a VSIX. All three have
 * package.json above out/, at varying depths once bundled.
 */
export function packageVersion(): string {
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      if (fs.existsSync(candidate)) {
        const pkg = JSON.parse(fs.readFileSync(candidate, "utf8"));
        // Only ours — a stray package.json in a parent directory is somebody
        // else's, and reporting their version would be worse than unknown.
        if (pkg.name === "jlink-mcp" && typeof pkg.version === "string") return pkg.version;
      }
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  // Say so rather than inventing a plausible number. A wrong version is
  // worse than an admitted unknown, because it looks like it was checked.
  return "unknown";
}
