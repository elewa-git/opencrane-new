// Prints "name<TAB>version<TAB>licence" for every npm package in /opt/computer/node_modules.
// Run during the image build; the output is kept in /opt/computer/licences/components.txt.
import fs from "node:fs";
import path from "node:path";

const root = "/opt/computer/node_modules";
const rows = new Set();

function licenceOf(pkg) {
  if (typeof pkg.license === "string") return pkg.license;
  if (pkg.license?.type) return pkg.license.type;
  if (Array.isArray(pkg.licenses)) return pkg.licenses.map((l) => l.type ?? l).join(" OR ");
  return "UNKNOWN";
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.name.startsWith("@")) {
      walk(full);
      continue;
    }
    const manifest = path.join(full, "package.json");
    if (fs.existsSync(manifest)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
        rows.add(`${pkg.name}\t${pkg.version}\t${licenceOf(pkg)}`);
      } catch {
        /* skip unreadable manifests */
      }
      const nested = path.join(full, "node_modules");
      if (fs.existsSync(nested)) walk(nested);
    }
  }
}

if (fs.existsSync(root)) walk(root);
walk("/usr/local/lib/node_modules");
const allowed = new Set(["Apache-2.0", "MIT", "ISC", "BSD-2-Clause", "BSD-3-Clause"]);
for (const row of rows) {
  if (!allowed.has(row.split("\t")[2])) throw new Error(`Unreviewed runtime npm licence: ${row}`);
}
console.log([...rows].sort().join("\n"));
