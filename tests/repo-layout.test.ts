import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Where a file goes: AGENTS.md → "Repository layout". Tracked + untracked, never ignored.
const TREE = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  encoding: "utf8",
})
  .split("\n")
  .filter(Boolean);

// The entries right under `dir`; folders only when `foldersOnly`.
const entries = (dir: string, foldersOnly = false) => [
  ...new Set(
    TREE.filter((f) => f.startsWith(dir))
      .map((f) => f.slice(dir.length).split("/"))
      .filter((parts) => !foldersOnly || parts.length > 1)
      .map((parts) => parts[0]),
  ),
];

// Only what a tool, GitHub or a public URL needs at the root.
const ROOT: Record<string, string> = {
  ".dockerignore": "docker build",
  ".env.example": "the boot variables, by convention",
  ".git-blame-ignore-revs": "GitHub reads it only here",
  ".githooks": "core.hooksPath (package.json prepare)",
  ".github": "GitHub",
  ".gitignore": "git",
  ".prettierignore": "prettier",
  ".prettierrc.json": "prettier",
  "AGENTS.md": "agents read it at the root",
  "CLAUDE.md": "agents read it at the root",
  "CONTEXT.md": "the glossary skills look for at the root",
  Dockerfile: "docker build and docker-image.yml",
  LICENSE: "GitHub detects the license only here",
  "README.md": "GitHub",
  app: "Next.js",
  "bun.lock": "bun",
  components: "the UI",
  "components.json": "shadcn",
  "docker-compose.yml":
    "builds from the Dockerfile beside it; the install docs cite it",
  docs: "ADRs and agent docs",
  "drizzle.config.ts": "drizzle-kit",
  "eslint.config.mjs": "eslint",
  "install-agent.sh": "kept beside install.sh",
  "install.sh": "deplo.build/install.sh fetches raw main/install.sh",
  "instrumentation.ts": "Next.js reads it only here",
  lib: "the code",
  "next.config.ts": "Next.js",
  "package.json": "bun",
  "postcss.config.mjs": "Tailwind",
  "proxy.ts": "Next.js reads it only here",
  public: "Next.js static files",
  scripts: "commands package.json, CI or a doc runs",
  tests: "repo-wide guard tests",
  "tsconfig.json": "tsc",
  "uninstall.sh": "deplo.build/uninstall.sh fetches raw main/uninstall.sh",
};

test("the root holds only what has to live there", () => {
  const extra = entries("").filter((name) => !(name in ROOT));
  assert.deepEqual(
    extra,
    [],
    "move it into a folder (AGENTS.md → Repository layout), or add it to ROOT with the tool that needs it",
  );
});

// Route groups don't change a URL, so a new section goes into one of them.
const APP_FLAT = [
  ".well-known",
  "api",
  "moving",
  "oauth",
  "register",
  "setup",
  "takeover",
  "welcome",
];

test("app/ is route groups plus a fixed set of flat routes", () => {
  const extra = entries("app/", true).filter(
    (n) => !/^\(.+\)$/.test(n) && !APP_FLAT.includes(n),
  );
  assert.deepEqual(
    extra,
    [],
    "put the route in a group: (dashboard), (focus), (auth), (legacy) or (scripts)",
  );
});

// A ratchet: these predate the rule. The list only shrinks.
const LOOSE_LIB = [
  "activity-filter.test.ts",
  "activity-filter.ts",
  "activity-types.ts",
  "after-paint.ts",
  "agent-reachability.ts",
  "alerts.test.ts",
  "alerts.ts",
  "ansi.test.ts",
  "ansi.ts",
  "auth.test.ts",
  "auto-domain-suggestion.test.ts",
  "auto-domain-suggestion.ts",
  "avatar-colors.ts",
  "avatar.ts",
  "backup-hold.test.ts",
  "backup-hold.ts",
  "breadcrumb-model.test.ts",
  "breadcrumb-model.ts",
  "build-phases.test.ts",
  "build-phases.ts",
  "capabilities.ts",
  "clipboard.test.ts",
  "clipboard.ts",
  "crypto.test.ts",
  "crypto.ts",
  "data-dir.ts",
  "deployment-status.ts",
  "destination-probe.ts",
  "dns-zone.ts",
  "docs.ts",
  "domain-issues.test.ts",
  "domain-issues.ts",
  "env-bulk.test.ts",
  "env-bulk.ts",
  "env-file.test.ts",
  "env-file.ts",
  "env-grouping.test.ts",
  "env-grouping.ts",
  "env-secret-name.test.ts",
  "env-secret-name.ts",
  "exec-line-editor.test.ts",
  "exec-line-editor.ts",
  "experiments.ts",
  "folder-colors.ts",
  "frameworks.test.ts",
  "frameworks.ts",
  "friendly-words.test.ts",
  "friendly-words.ts",
  "graphql-client.test.ts",
  "graphql-client.ts",
  "graphql-vars.test.ts",
  "graphql-vars.ts",
  "gsap.ts",
  "hold-exit.test.ts",
  "hold-exit.ts",
  "host-address.test.ts",
  "host-address.ts",
  "ids.ts",
  "install-script.test.ts",
  "install-script.ts",
  "install-version.test.ts",
  "legacy-redirect.test.ts",
  "legacy-redirect.ts",
  "links.ts",
  "live-session-guard.ts",
  "log-level-detect.test.ts",
  "log-level-detect.ts",
  "log-levels.ts",
  "logs-display.test.ts",
  "logs-display.ts",
  "match-query.test.ts",
  "match-query.ts",
  "member-grants.test.ts",
  "membership-shared.test.ts",
  "membership-shared.ts",
  "membership.ts",
  "nav.ts",
  "optimistic-remove.test.ts",
  "optimistic-remove.ts",
  "optimistic-value.test.ts",
  "optimistic-value.ts",
  "otp-field.test.ts",
  "otp-field.ts",
  "outbound-url.test.ts",
  "outbound-url.ts",
  "overview-links.test.ts",
  "overview-links.ts",
  "owner-bootstrap.test.ts",
  "passkey-ceremony.test.ts",
  "passkey-client.ts",
  "passkey-policy.ts",
  "passkey.test.ts",
  "password-policy.test.ts",
  "password-policy.ts",
  "portal-event-scope.test.ts",
  "portal-event-scope.ts",
  "public-url.test.ts",
  "public-url.ts",
  "pwned-password.test.ts",
  "pwned-password.ts",
  "release-notes.test.ts",
  "release-notes.ts",
  "reorder-block.test.ts",
  "reorder-block.ts",
  "request-cache.test.ts",
  "request-cache.ts",
  "result.ts",
  "route-loading.test.ts",
  "schedule.test.ts",
  "schedule.ts",
  "security.test.ts",
  "security.ts",
  "server-connection.ts",
  "stale-build.test.ts",
  "stale-build.ts",
  "stale-sweep.test.ts",
  "stale-sweep.ts",
  "team-path.test.ts",
  "team-path.ts",
  "team-switch.test.ts",
  "team-switch.ts",
  "templates-blueprint.test.ts",
  "templates-blueprint.ts",
  "third-party-notices.test.ts",
  "token-presets.test.ts",
  "token-presets.ts",
  "token-scope-search.test.ts",
  "token-scope-search.ts",
  "two-factor-qr.test.ts",
  "two-factor.test.ts",
  "use-graphql.ts",
  "user-agent.test.ts",
  "user-agent.ts",
  "username.test.ts",
  "username.ts",
  "utils.test.ts",
  "utils.ts",
  "version.test.ts",
  "version.ts",
  "webauthn-test-helpers.ts",
  "wildcard-dns.ts",
  "wizard-step.test.ts",
  "wizard-step.ts",
  "www-redirect.test.ts",
  "www-redirect.ts",
  "yaml.test.ts",
  "yaml.ts",
];

test("no new file lands loose in lib/", () => {
  const loose = TREE.filter((f) => /^lib\/[^/]+$/.test(f)).map((f) =>
    f.slice(4),
  );
  assert.deepEqual(
    loose.filter((n) => !LOOSE_LIB.includes(n)),
    [],
    "put it in the lib/<domain>/ folder it belongs to",
  );
  assert.deepEqual(
    LOOSE_LIB.filter((n) => !loose.includes(n)),
    [],
    "it moved or went: take it off LOOSE_LIB",
  );
});

test("every script in scripts/ is run by something", () => {
  const callers = TREE.filter(
    (f) =>
      f === "package.json" ||
      f === "Dockerfile" ||
      f === "AGENTS.md" ||
      /^\.github\/.+\.(ya?ml|md)$/.test(f) ||
      /^docs\/.+\.md$/.test(f),
  )
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  const unused = TREE.filter((f) => f.startsWith("scripts/")).filter(
    (f) => !callers.includes(f),
  );
  assert.deepEqual(
    unused,
    [],
    "name it in package.json, CI or a doc, or keep a one-off in the ignored .scratch/",
  );
});
