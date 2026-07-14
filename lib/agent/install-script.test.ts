import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderInstallScript } from "./install-script";
import { __resetReleaseCacheForTests } from "./release";

/**
 * The install script is a TEMPLATE: the control plane fills in the per-arch
 * binary URLs + sha256s via a plain replaceAll of the `__…__` sentinels at serve
 * time, reading them from the latest GitHub release of DeploCloud/deplo-agent.
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
  amd64Url: "https://github.com/DeploCloud/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-amd64",
  amd64Sha: "a".repeat(64),
  arm64Url: "https://github.com/DeploCloud/deplo-agent/releases/download/v2.3.0/deplo-agent-linux-arm64",
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

/* ------------------------------------------------------------------ */
/* The Docker address-pool step                                        */
/* ------------------------------------------------------------------ */

/**
 * Docker's default pools cap a host at ~31 networks and Deplo takes one PER APP,
 * so both installers widen the pool. Three invariants, and every one of them
 * fails SILENTLY if broken — hence the tests.
 *
 *  - ORDER. The step must run before ANYTHING allocates a subnet. Move it below
 *    `docker network create deplo` and it still runs, still prints [ok], and
 *    still leaves the host capped: the daemon only reads pools at restart, and by
 *    then Traefik has already taken a subnet from the OLD ones.
 *  - NO 10.0.0.0/8. Coolify hardcoded exactly that and it swallowed hosts' own
 *    LAN/VPN, so dockerd refused to start — their #9537, the error the fix was
 *    meant to prevent. The base must be CHOSEN against the host's routes.
 *  - PARITY. The block is duplicated into install.sh and install-agent.sh: two
 *    standalone curl|bash scripts that cannot source a shared file. A "KEEP IN
 *    SYNC" comment is not a mechanism. This is.
 */

/** The address-pool block, comments and indentation stripped, for comparison. */
function poolBlock(script: string): string {
  const start = script.indexOf("pool_candidate_is_free() {");
  const end = script.indexOf("\nconfigure_docker_address_pools\n", start);
  assert.ok(start >= 0 && end > start, "address-pool block not found in installer");
  return script
    .slice(start, end)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"))
    .join("\n");
}

test("the address-pool step runs BEFORE anything creates a docker network", async () => {
  const restore = stubReleaseFetch();
  __resetReleaseCacheForTests();
  try {
    const agent = await renderInstallScript();
    assert.ok(agent);
    const configured = agent!.indexOf("\nconfigure_docker_address_pools\n");
    const firstNetwork = agent!.indexOf("docker network create deplo");
    assert.ok(configured > 0, "install-agent.sh never calls configure_docker_address_pools");
    assert.ok(firstNetwork > 0, "install-agent.sh no longer creates the deplo network?");
    assert.ok(
      configured < firstNetwork,
      "pools are configured AFTER the first network is created — the host stays capped at ~31 apps",
    );

    const host = await readFile(join(process.cwd(), "install.sh"), "utf8");
    const hostConfigured = host.indexOf("\nconfigure_docker_address_pools\n");
    const hostNetwork = host.indexOf("docker network inspect deplo");
    assert.ok(hostConfigured > 0, "install.sh never calls configure_docker_address_pools");
    assert.ok(hostNetwork > 0, "install.sh no longer creates the deplo network?");
    assert.ok(
      hostConfigured < hostNetwork,
      "install.sh configures pools AFTER creating the deplo network — the step is a no-op",
    );
  } finally {
    restore();
  }
});

test("no installer ever hardcodes 10.0.0.0/8 as the address pool", async () => {
  for (const file of ["install.sh", "install-agent.sh"]) {
    const script = await readFile(join(process.cwd(), file), "utf8");
    // CODE only: the block comment names the range precisely to warn the next
    // editor off it, and a test that can't tell prose from config would fire on
    // the warning itself.
    const code = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.ok(
      !code.includes("10.0.0.0/8"),
      `${file} hardcodes 10.0.0.0/8 — it swallows the host's own LAN/VPN and dockerd won't start`,
    );
  }
});

test("both installers carry the SAME address-pool block", async () => {
  const host = await readFile(join(process.cwd(), "install.sh"), "utf8");
  const agent = await readFile(join(process.cwd(), "install-agent.sh"), "utf8");
  assert.equal(
    poolBlock(host),
    poolBlock(agent),
    "install.sh and install-agent.sh have drifted — the address-pool block must stay identical",
  );
});
