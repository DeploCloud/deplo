/**
 * Import one-click templates from a blueprints source tree into Deplo.
 *
 *   node scripts/import-templates.mjs <source-dir>
 *
 * <source-dir> must contain `meta.json` + `blueprints/<id>/` folders. The script
 * copies each blueprint (docker-compose.yml, template.toml, instructions.md)
 * into templates/blueprints/<id>/, copies its logo into public/templates/, strips
 * any upstream branding, and writes the aggregate templates/catalog.json the app
 * reads. Descriptions are improved separately (see improve step).
 */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { join, extname } from "node:path";

const SRC = process.argv[2];
if (!SRC) {
  console.error("usage: node scripts/import-templates.mjs <source-dir>");
  process.exit(1);
}

const ROOT = process.cwd();
const OUT_BP = join(ROOT, "templates", "blueprints");
const OUT_LOGOS = join(ROOT, "public", "templates");

// Strip upstream branding ("dokploy" -> "deplo"), preserving case.
function rebrand(s) {
  return s.replace(/dokploy/gi, (m) =>
    m === "DOKPLOY" ? "DEPLO" : m[0] === "D" ? "Deplo" : "deplo"
  );
}

// Curated "popular" set (well-known self-hosted apps).
const POPULAR = new Set([
  "pocketbase", "n8n", "plausible", "umami", "ghost", "wordpress", "supabase",
  "minio", "uptime-kuma", "grafana", "nextcloud", "metabase", "appwrite",
  "directus", "strapi", "ollama", "vaultwarden", "gitea", "portainer",
  "postgres", "redis", "mysql", "mongodb", "open-webui", "affine", "outline",
  "documenso", "cal", "rustdesk", "jellyfin", "immich", "linkwarden",
]);

const meta = JSON.parse(readFileSync(join(SRC, "meta.json"), "utf8"));

rmSync(OUT_BP, { recursive: true, force: true });
mkdirSync(OUT_BP, { recursive: true });
mkdirSync(OUT_LOGOS, { recursive: true });

const catalog = [];
let copied = 0;
let skipped = 0;

for (const entry of meta) {
  const id = entry.id;
  if (!id || id.startsWith("dokploy")) {
    skipped++;
    continue;
  }
  const srcDir = join(SRC, "blueprints", id);
  if (!existsSync(srcDir)) {
    skipped++;
    continue;
  }
  const destDir = join(OUT_BP, id);
  mkdirSync(destDir, { recursive: true });

  // Copy + rebrand the text artifacts.
  for (const file of ["docker-compose.yml", "template.toml", "instructions.md"]) {
    const sp = join(srcDir, file);
    if (existsSync(sp)) {
      writeFileSync(join(destDir, file), rebrand(readFileSync(sp, "utf8")));
    }
  }

  // Logo: copy to public/templates/<id>.<ext> and record a servable URL.
  let logoUrl = null;
  const logoName = entry.logo;
  if (logoName && existsSync(join(srcDir, logoName))) {
    const ext = extname(logoName).toLowerCase() || ".png";
    copyFileSync(join(srcDir, logoName), join(OUT_LOGOS, `${id}${ext}`));
    logoUrl = `/templates/${id}${ext}`;
  }

  const item = {
    id,
    name: entry.name || id,
    description: rebrand(entry.description || ""),
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    logo: logoUrl,
    links: entry.links || {},
    version: entry.version || "latest",
    popular: POPULAR.has(id),
  };
  // Per-folder metadata (keeps the source's folder-per-template structure).
  writeFileSync(join(destDir, "meta.json"), JSON.stringify(item, null, 2));
  catalog.push(item);
  copied++;
}

catalog.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(ROOT, "templates", "catalog.json"), JSON.stringify(catalog, null, 2));

const tagCounts = {};
for (const t of catalog) for (const tag of t.tags) tagCounts[tag] = (tagCounts[tag] || 0) + 1;
const topTags = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]).slice(0, 20);

console.log(`imported ${copied} templates, skipped ${skipped}`);
console.log(`popular: ${catalog.filter((c) => c.popular).length}`);
console.log(`logos: ${catalog.filter((c) => c.logo).length}/${catalog.length}`);
console.log(`top tags: ${topTags.map(([t, n]) => `${t}(${n})`).join(", ")}`);
