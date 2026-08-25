/**
 * Verifies every entry of `lib/docs.ts` against the manual: page exists, and the
 * `#anchor` matches a real heading. Run it after the manual moves.
 *   bunx tsx scripts/check-docs-links.mts [path-to-DeploCloud/docs clone]
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { DOCS, docsUrl, type DocsTopic } from "../lib/docs";

const clone = process.argv[2] ?? "/root/projects/deplo-docs";
const root = join(clone, "content/docs");

if (!existsSync(root)) {
  console.error(`No docs clone at ${clone} - pass the path as an argument.`);
  process.exit(1);
}

// github-slugger's character class, which is what fumadocs' remark-heading uses.
const PUNCTUATION = /[ -⁯⸀-⹿\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~]/g;

function slugify(heading: string) {
  return heading
    .replace(/`/g, "")
    .trim()
    .toLowerCase()
    .replace(PUNCTUATION, "")
    .replace(/\s/g, "-");
}

function walk(dir: string, out: string[] = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith(".mdx")) out.push(p);
  }
  return out;
}

/** A route group `(docs)` is stripped from the URL, `index` is its folder. */
function urlFor(file: string) {
  let p = relative(root, file).replace(/\.mdx$/, "");
  p = p
    .split("/")
    .filter((s) => !(s.startsWith("(") && s.endsWith(")")))
    .join("/");
  if (p.endsWith("/index")) p = p.slice(0, -"/index".length);
  return p === "index" ? "" : p;
}

function anchorsOf(file: string) {
  const seen = new Map<string, number>();
  const anchors = new Set<string>();
  let inFence = false;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const h = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (!h) continue;
    const base = slugify(h[1].replace(/\{#[^}]*\}$/, ""));
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n > 0 ? `${base}-${n}` : base);
  }
  return anchors;
}

const pages = new Map<string, Set<string>>();
for (const file of walk(root)) pages.set(urlFor(file), anchorsOf(file));

const problems: string[] = [];
for (const topic of Object.keys(DOCS) as DocsTopic[]) {
  const [path, anchor] = DOCS[topic].split("#");
  const anchors = pages.get(path);
  if (!anchors) {
    problems.push(`${topic}: no page at /${path}`);
    continue;
  }
  if (anchor && !anchors.has(anchor))
    problems.push(`${topic}: /${path} has no #${anchor}`);
}

const total = Object.keys(DOCS).length;
if (problems.length) {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} of ${total} topics are broken.`);
  process.exit(1);
}
console.log(`${total} topics ok (${pages.size} pages in ${clone}).`);
console.log(`e.g. ${docsUrl("build.port")}`);
