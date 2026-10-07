import { execFileSync } from "node:child_process";

const REPO = "DeploCloud/deplo";
const OWNER_LOGIN = "IdraDev";

// What the reader of a release page gets. Everything else (chore, docs, test, ci,
// build, refactor, revert, style) stays out. See docs/agents/releasing.md.
const SECTIONS = [
  ["feat", "🚀 Features"],
  ["ui", "💅 Interface"],
  ["fix", "🐛 Bug Fixes"],
  ["perf", "⚡ Performance"],
] as const;

const run = (cmd: string, args: string[]) =>
  execFileSync(cmd, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const git = (...args: string[]) => run("git", args);
const lines = (out: string) => out.split("\n").filter(Boolean);

const to = process.argv[2];
if (!to) {
  console.error(
    "usage: node --import tsx scripts/release-notes.mts <tag> [previous-tag]",
  );
  process.exit(1);
}
const tags = lines(git("tag", "--sort=creatordate", "--list", "v*"));
const from = process.argv[3] ?? tags[tags.indexOf(to) - 1];
const date = git("log", "-1", "--format=%cs", to);

const prOf = new Map<string, number>();
if (from) {
  for (const line of lines(
    git("log", "--merges", "--format=%H\x1f%P\x1f%s", `${from}..${to}`),
  )) {
    const [, parents, subject] = line.split("\x1f");
    const pr = /^Merge pull request #(\d+)/.exec(subject)?.[1];
    const [first, second] = parents.split(" ");
    if (!pr || !second) continue;
    for (const sha of lines(git("rev-list", `${first}..${second}`)))
      prOf.set(sha, Number(pr));
  }
}

const authorOf = new Map<string, string>();
if (from) {
  const json = run("gh", [
    "api",
    `repos/${REPO}/compare/${from}...${to}?per_page=250`,
    "-q",
    '.commits[] | .sha + "\\u001f" + (.author.login // "")',
  ]);
  for (const line of lines(json)) {
    const [sha, login] = line.split("\x1f");
    if (login) authorOf.set(sha, login);
  }
}

type Entry = {
  scope?: string;
  subject: string;
  sha: string;
  login?: string;
  pr?: number;
};
const grouped = new Map<string, Entry[]>();
const dropped: string[] = [];

const range = from ? `${from}..${to}` : to;
for (const line of lines(
  git("log", "--no-merges", "--format=%H\x1f%s", range),
)) {
  const [sha, raw] = line.split("\x1f");
  const parsed = /^(\w+)(?:\(([^)]+)\))?!?: (.+)$/.exec(raw);
  if (!parsed) {
    dropped.push(`? ${sha.slice(0, 8)} ${raw}`);
    continue;
  }
  const [, type, scope, rest] = parsed;
  const section = SECTIONS.find(([t]) => t === type)?.[1];
  if (!section) {
    dropped.push(`- ${sha.slice(0, 8)} ${raw}`);
    continue;
  }
  const inSubject = /\s*\(#(\d+)\)$/.exec(rest);
  const login = authorOf.get(sha);
  const entry: Entry = {
    scope,
    subject: inSubject ? rest.slice(0, inSubject.index) : rest,
    sha,
    login:
      login && login !== OWNER_LOGIN && !login.endsWith("[bot]")
        ? login
        : undefined,
    pr: inSubject ? Number(inSubject[1]) : prOf.get(sha),
  };
  grouped.set(section, [...(grouped.get(section) ?? []), entry]);
}

const compare = from
  ? `https://github.com/${REPO}/compare/${from}...${to}`
  : `https://github.com/${REPO}/commits/${to}`;
const out = [`## [${to}](${compare}) (${date})`, ""];

for (const [, section] of SECTIONS) {
  const entries = grouped.get(section);
  if (!entries?.length) continue;
  out.push("", `### ${section}`, "");
  for (const e of entries) {
    const credit =
      e.login && e.pr
        ? `, by @${e.login} in [#${e.pr}](https://github.com/${REPO}/pull/${e.pr})`
        : "";
    const commit = `[${e.sha.slice(0, 8)}](https://github.com/${REPO}/commit/${e.sha})`;
    out.push(
      `* ${e.scope ? `**${e.scope}:** ` : ""}${e.subject}${credit} (${commit})`,
    );
  }
}

const credits = [...grouped.values()]
  .flat()
  .flatMap((e) => (e.login ? [e.login] : []));
if (credits.length) {
  out.push("", "### 🤝 Contributors", "");
  for (const login of [...new Set(credits)]) out.push(`- @${login}`);
}

console.log(out.join("\n"));
if (dropped.length)
  console.error(`\nnot listed (${dropped.length}):\n${dropped.join("\n")}`);
