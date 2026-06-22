import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderInstallScript } from "./install-script";
import { __resetReleaseCacheForTests } from "./release";

/**
 * The install script is a TEMPLATE: the control plane fills in the per-arch
 * binary URLs + sha256s via a plain replaceAll of the `__…__` sentinels at serve
 * time, reading them from the latest GitHub release of PixelFederico/deplo-agent.
 * The script carries a self-guard that refuses to run the UNSUBSTITUTED repo copy.
 *
 * The trap (regression guarded here): if that guard compares against the literal
 * sentinel token, the same replaceAll rewrites the guard line too — so the
 * RENDERED script always trips its own guard and can never install. These tests
 * pin both halves of the contract: the rendered script must PASS its guard, and
 * the raw template must FAIL it. They render through the real renderInstallScript
 * (with a stubbed release fetch), so a future edit reintroducing the bug fails CI.
 */

const FAKE = {
  tag: "v2.3.0",
  amd64Url: "https://github.com/PixelFederico/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-amd64",
  amd64Sha: "a".repeat(64),
  arm64Url: "https://github.com/PixelFederico/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-arm64",
  arm64Sha: "b".repeat(64),
};

/**
 * Stub global fetch to serve a release whose assets include both arch binaries
 * plus a checksums.txt. resolveLatestAgentRelease makes two calls: the release
 * JSON, then the checksums asset — we branch on the URL.
 */
function stubReleaseFetch() {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      return new Response(
        JSON.stringify({
          tag_name: FAKE.tag,
          assets: [
            { name: "deplo-agent-linux-amd64", browser_download_url: FAKE.amd64Url },
            { name: "deplo-agent-linux-arm64", browser_download_url: FAKE.arm64Url },
            { name: "checksums.txt", browser_download_url: "https://example/checksums.txt" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("checksums.txt")) {
      return new Response(
        `${FAKE.amd64Sha}  deplo-agent-linux-amd64\n${FAKE.arm64Sha}  deplo-agent-linux-arm64\n`,
        { status: 200 },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

afterEach(() => {
  __resetReleaseCacheForTests();
});

/** Pull a `KEY="value"` assignment out of the rendered script. */
function shVar(script: string, name: string): string | null {
  const m = script.match(new RegExp(`^${name}="([^"]*)"`, "m"));
  return m ? m[1] : null;
}

test("renderInstallScript substitutes per-arch URLs + sha256 from the release", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script, "expected a rendered script (release resolvable)");
    assert.equal(shVar(script!, "AGENT_VERSION"), "2.3.0");
    assert.equal(shVar(script!, "AGENT_URL_AMD64"), FAKE.amd64Url);
    assert.equal(shVar(script!, "AGENT_SHA256_AMD64"), FAKE.amd64Sha);
    assert.equal(shVar(script!, "AGENT_URL_ARM64"), FAKE.arm64Url);
    assert.equal(shVar(script!, "AGENT_SHA256_ARM64"), FAKE.arm64Sha);
  } finally {
    restore();
  }
});

test("renderInstallScript returns null when no release can be resolved", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("not found", { status: 404 })) as typeof fetch;
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.equal(script, null, "unresolvable release must 503 (null), not serve unverifiable installer");
  } finally {
    globalThis.fetch = orig;
  }
});

test("rendered script does NOT contain an unsubstituted sentinel token", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script);
    assert.ok(!script!.includes("__AGENT_URL_AMD64__"), "still contains __AGENT_URL_AMD64__");
    assert.ok(!script!.includes("__AGENT_SHA256_AMD64__"));
    assert.ok(!script!.includes("__AGENT_VERSION__"));
  } finally {
    restore();
  }
});

test("the self-guard PASSES on the rendered script (would-fire bug regression)", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const script = await renderInstallScript();
    assert.ok(script);
    const url = shVar(script!, "AGENT_URL_AMD64")!;
    assert.ok(
      !guardMatches(url),
      "rendered AGENT_URL_AMD64 trips the install guard — the script can never run",
    );
  } finally {
    restore();
  }
});

test("the self-guard FIRES on the raw repo template", async () => {
  const template = await readFile(join(process.cwd(), "install-agent.sh"), "utf8");
  const url = shVar(template, "AGENT_URL_AMD64")!;
  assert.ok(
    guardMatches(url),
    "raw template AGENT_URL_AMD64 must trip the guard (refuse the repo copy)",
  );
});

/**
 * Mirror the shell guard `case "$AGENT_URL_AMD64" in *__AGENT_URL*AMD64__*)`. The
 * pattern is the sentinel split by a wildcard so the exact token never appears
 * literally where replaceAll could rewrite it.
 */
function guardMatches(url: string): boolean {
  return /__AGENT_URL.*AMD64__/.test(url);
}
