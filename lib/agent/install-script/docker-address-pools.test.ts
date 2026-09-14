import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { renderInstallScript } from "../install-script";
import { __resetReleaseCacheForTests } from "../release";
import { stubReleaseFetch } from "./install-script-test-helpers";

afterEach(() => {
  __resetReleaseCacheForTests();
});

// Docker's default pools cap a host at ~31 networks and Deplo takes one PER APP, so the step must run before anything allocates a subnet.

// Matched by regex, not by the literal call: install-agent.sh wraps it in a storage-only guard, so it is indented there and bare in install.sh.
function poolCallIndex(script: string): number {
  return script.search(/^[ \t]*configure_docker_address_pools$/m);
}

function poolBlock(script: string): string {
  const start = script.indexOf("pool_candidate_is_free() {");
  // Up to the END of the second definition, not the call: parity is about the two DEFINITIONS, and the call site legitimately differs.
  const end = script.lastIndexOf("\n}\n", poolCallIndex(script)) + 3;
  assert.ok(
    start >= 0 && end > start,
    "address-pool block not found in installer",
  );
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
    const configured = poolCallIndex(agent!);
    const firstNetwork = agent!.indexOf("docker network create deplo");
    assert.ok(
      configured > 0,
      "install-agent.sh never calls configure_docker_address_pools",
    );
    assert.ok(
      firstNetwork > 0,
      "install-agent.sh no longer creates the Deplo network?",
    );
    assert.ok(
      configured < firstNetwork,
      "pools are configured AFTER the first network is created - the host stays capped at ~31 apps",
    );

    const host = await readFile(join(process.cwd(), "install.sh"), "utf8");
    const hostConfigured = poolCallIndex(host);
    const hostNetwork = host.indexOf("docker network inspect deplo");
    assert.ok(
      hostConfigured > 0,
      "install.sh never calls configure_docker_address_pools",
    );
    assert.ok(
      hostNetwork > 0,
      "install.sh no longer creates the Deplo network?",
    );
    assert.ok(
      hostConfigured < hostNetwork,
      "install.sh configures pools AFTER creating the Deplo network - the step is a no-op",
    );
  } finally {
    restore();
  }
});

test("no installer ever hardcodes 10.0.0.0/8 as the address pool", async () => {
  for (const file of ["install.sh", "install-agent.sh"]) {
    const script = await readFile(join(process.cwd(), file), "utf8");
    // CODE only: the block comment names the range to warn the next editor off it, and this test would otherwise fire on the warning.
    const code = script
      .split("\n")
      .filter((l) => !l.trim().startsWith("#"))
      .join("\n");
    assert.ok(
      !code.includes("10.0.0.0/8"),
      `${file} hardcodes 10.0.0.0/8 - it swallows the host's own LAN/VPN and dockerd won't start`,
    );
  }
});

test("both installers carry the SAME address-pool block", async () => {
  const host = await readFile(join(process.cwd(), "install.sh"), "utf8");
  const agent = await readFile(join(process.cwd(), "install-agent.sh"), "utf8");
  assert.equal(
    poolBlock(host),
    poolBlock(agent),
    "install.sh and install-agent.sh have drifted - the address-pool block must stay identical",
  );
});
