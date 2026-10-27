import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const LICENSE_FILE = /^(licen[cs]e|copying|notice)/i;
const RULE = "-".repeat(79);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

// Node's own lookup: the nearest node_modules/<name>, walking up to the root.
function resolvePackage(name, fromDir, root) {
  for (let dir = fromDir; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, "node_modules", name);
    if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    if (dir === root || dir === path.dirname(dir)) return null;
  }
}

function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => x?.type ?? x).join(" OR ");
  return l?.type ?? "UNKNOWN";
}

function sourceOf(pkg) {
  const repo =
    typeof pkg.repository === "string" ? pkg.repository : pkg.repository?.url;
  return (repo ?? pkg.homepage ?? "")
    .replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

function read(file) {
  return fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n").trim();
}

// No license file: the README's own "License" section, which is where libvips keeps its table.
function readmeLicense(dir, files) {
  const readme = files.find((f) => /^readme/i.test(f));
  if (!readme) return [];
  const lines = read(path.join(dir, readme)).split("\n");
  const start = lines.findIndex((l) => /^#+\s*licen[cs]/i.test(l));
  if (start < 0) return [];
  const level = lines[start].match(/^#+/)[0].length;
  const end = lines.findIndex(
    (l, i) => i > start && /^#+\s/.test(l) && l.match(/^#+/)[0].length <= level,
  );
  return [
    lines
      .slice(start, end < 0 ? undefined : end)
      .join("\n")
      .trim(),
  ];
}

function licenseTexts(dir) {
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort();
  const texts = files
    .filter((f) => LICENSE_FILE.test(f))
    .map((f) => read(path.join(dir, f)));
  return texts.length > 0 ? texts : readmeLicense(dir, files);
}

// A GitHub repository page, or null: npm shorthands ("user/repo") are GitHub too.
export function githubUrl(repository) {
  const url = typeof repository === "string" ? repository : repository?.url;
  const m =
    url?.match(/^(?:github:)?([\w.-]+\/[\w.-]+)$/) ??
    url?.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?(?:[/#].*)?$/i);
  if (!m) return null;
  const dir = typeof repository === "object" && repository.directory;
  return `https://github.com/${m[1]}${dir ? `/tree/HEAD/${dir}` : ""}`;
}

/** Every package the root's `dependencies` pull in at run time, sorted, with its license text. */
export function collectNotices(root) {
  const found = new Map();
  const queue = [root];
  while (queue.length > 0) {
    const dir = queue.pop();
    const pkg = readJson(path.join(dir, "package.json"));
    const deps = { ...pkg.optionalDependencies, ...pkg.dependencies };
    for (const name of Object.keys(deps)) {
      const dep = resolvePackage(name, dir, root);
      if (!dep || found.has(dep)) continue;
      found.set(dep, readJson(path.join(dep, "package.json")));
      queue.push(dep);
    }
  }

  const notices = new Map();
  for (const [dir, pkg] of found) {
    const id = `${pkg.name}@${pkg.version}`;
    if (notices.has(id)) continue;
    notices.set(id, {
      name: pkg.name,
      version: pkg.version,
      license: licenseOf(pkg),
      source: sourceOf(pkg),
      github: githubUrl(pkg.repository),
      text: licenseTexts(dir).join("\n\n"),
    });
  }
  return [...notices.keys()].sort().map((id) => notices.get(id));
}

/** The plain-text download of the same list. */
export function renderNotices(notices) {
  return [
    "Deplo is licensed under AGPL-3.0-only: https://github.com/DeploCloud/deplo",
    "It includes the open source software below, each under its own license.",
    "",
    ...notices.map((n) =>
      [
        RULE,
        `${n.name}@${n.version}`,
        `License: ${n.license}`,
        ...(n.source ? [`Source: ${n.source}`] : []),
        "",
        n.text ||
          "No license file ships with this package; its source above carries the license.",
        "",
      ].join("\n"),
    ),
  ].join("\n");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const notices = collectNotices(root);
  const out = path.join(root, "public", "third-party-notices");
  fs.writeFileSync(`${out}.txt`, renderNotices(notices));
  fs.writeFileSync(`${out}.json`, JSON.stringify(notices));
}
