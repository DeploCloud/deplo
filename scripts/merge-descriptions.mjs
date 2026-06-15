/**
 * Apply description patches (templates/.patches/*.json) onto templates/catalog.json
 * and each templates/blueprints/<id>/meta.json. Run after the description workflow.
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const PATCH_DIR = join(ROOT, "templates", ".patches");
const CATALOG = join(ROOT, "templates", "catalog.json");

const map = new Map();
for (const f of readdirSync(PATCH_DIR).filter((f) => f.endsWith(".json"))) {
  const arr = JSON.parse(readFileSync(join(PATCH_DIR, f), "utf8"));
  for (const { id, description } of arr) {
    if (id && description) map.set(id, description.trim());
  }
}

const catalog = JSON.parse(readFileSync(CATALOG, "utf8"));
let applied = 0;
const missing = [];
for (const item of catalog) {
  const d = map.get(item.id);
  if (d) {
    item.description = d;
    applied++;
    const metaPath = join(ROOT, "templates", "blueprints", item.id, "meta.json");
    if (existsSync(metaPath)) {
      const m = JSON.parse(readFileSync(metaPath, "utf8"));
      m.description = d;
      writeFileSync(metaPath, JSON.stringify(m, null, 2));
    }
  } else {
    missing.push(item.id);
  }
}

writeFileSync(CATALOG, JSON.stringify(catalog, null, 2));
console.log(`patches: ${map.size}, applied: ${applied}/${catalog.length}`);
if (missing.length) console.log(`MISSING (${missing.length}): ${missing.join(", ")}`);
