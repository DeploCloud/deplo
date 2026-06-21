import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderInstallScript } from "./install-script";

/**
 * The install script is a TEMPLATE: the control plane fills in the binary URL +
 * sha256 via a plain replaceAll of the `__…__` sentinels at serve time, and the
 * script carries a self-guard that refuses to run the UNSUBSTITUTED repo copy.
 *
 * The trap (regression guarded here): if that guard compares against the literal
 * sentinel token, the same replaceAll rewrites the guard line too — so the
 * RENDERED script always trips its own guard and can never install. These tests
 * pin both halves of the contract: the rendered script must PASS its guard, and
 * the raw template must FAIL it. They render through the real renderInstallScript
 * (mirroring the serve path), so a future edit that reintroduces the bug fails CI.
 */

// Point the binary at any existing file so renderInstallScript doesn't bail to
// null (it hashes the binary; the exact bytes/sha don't matter for the guard).
const ORIG_BIN = process.env.DEPLO_AGENT_BIN;
process.env.DEPLO_AGENT_BIN = join(process.cwd(), "package.json");

const BASE = "https://deplo.example.com";

/** Pull a `KEY="value"` assignment out of the rendered script. */
function shVar(script: string, name: string): string | null {
  const m = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  return m ? m[1] : null;
}

test("renderInstallScript substitutes the binary URL + sha256", async () => {
  const script = await renderInstallScript(BASE);
  assert.ok(script, "expected a rendered script (binary present)");
  assert.equal(
    shVar(script!, "AGENT_BIN_URL"),
    `${BASE}/install-agent/deplo-agent`,
  );
  const sha = shVar(script!, "AGENT_SHA256");
  assert.match(sha ?? "", /^[0-9a-f]{64}$/, "sha256 should be filled in");
});

test("rendered script does NOT contain the unsubstituted sentinel token", async () => {
  const script = await renderInstallScript(BASE);
  assert.ok(script);
  // The exact token must survive nowhere in the served script — if it does, the
  // replaceAll missed a spot (or the guard would have been rewritten).
  assert.ok(
    !script!.includes("__AGENT_BIN_URL__"),
    "rendered script still contains __AGENT_BIN_URL__",
  );
  assert.ok(!script!.includes("__AGENT_SHA256__"));
});

test("the self-guard PASSES on the rendered script (would-fire bug regression)", async () => {
  const script = await renderInstallScript(BASE);
  assert.ok(script);
  const url = shVar(script!, "AGENT_BIN_URL")!;
  // Re-implement the script's own guard test (the `case` glob) in JS and assert
  // it does NOT match a real rendered URL — i.e. the rendered script would run.
  assert.ok(
    !guardMatches(url),
    "rendered AGENT_BIN_URL trips the install guard — the script can never run",
  );
});

test("the self-guard FIRES on the raw repo template", async () => {
  const template = await readFile(
    join(process.cwd(), "install-agent.sh"),
    "utf8",
  );
  const url = shVar(template, "AGENT_BIN_URL")!;
  assert.ok(
    guardMatches(url),
    "raw template AGENT_BIN_URL must trip the guard (refuse the repo copy)",
  );
});

/**
 * Mirror the shell guard `case "$AGENT_BIN_URL" in *__AGENT_BIN*URL__*)`. The
 * pattern is the sentinel split by a wildcard so the exact token never appears
 * literally where replaceAll could rewrite it.
 */
function guardMatches(url: string): boolean {
  return /__AGENT_BIN.*URL__/.test(url);
}

test.after(() => {
  if (ORIG_BIN === undefined) delete process.env.DEPLO_AGENT_BIN;
  else process.env.DEPLO_AGENT_BIN = ORIG_BIN;
});
