import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { AGENT_VERSION } from "../version";
import {
  AGENT_REPO,
  __resetReleaseCacheForTests,
  resolveAgentRelease,
} from "./release";

function stub(respond: (url: string) => Response) {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    return respond(url);
  }) as typeof fetch;
  return { seen, restore: () => void (globalThis.fetch = orig) };
}

afterEach(() => __resetReleaseCacheForTests());

const base = `https://github.com/${AGENT_REPO}/releases/download/v${AGENT_VERSION}`;

test("resolves the pinned tag from its checksums.txt, never the API", async () => {
  const { seen, restore } = stub(
    () =>
      new Response(
        `${"a".repeat(64)}  deplo-agent-linux-amd64\n` +
          `${"b".repeat(64)} *deplo-agent-linux-arm64\n`,
      ),
  );
  try {
    const rel = await resolveAgentRelease();
    assert.equal(rel?.version, AGENT_VERSION);
    assert.deepEqual(rel!.binaries.amd64, {
      url: `${base}/deplo-agent-linux-amd64`,
      sha256: "a".repeat(64),
    });
    assert.equal(rel!.binaries.arm64!.sha256, "b".repeat(64));
    assert.deepEqual(seen, [`${base}/checksums.txt`]);
  } finally {
    restore();
  }
});

test("a single published arch is fine; the missing one is null", async () => {
  const { restore } = stub(
    () => new Response(`${"c".repeat(64)}  deplo-agent-linux-amd64\n`),
  );
  try {
    const rel = await resolveAgentRelease();
    assert.equal(rel!.binaries.arm64, null);
  } finally {
    restore();
  }
});

test("a missing or empty checksums.txt is no release, so no unverified binary is served", async () => {
  for (const res of [
    () => new Response("nope", { status: 404 }),
    () => new Response("garbage"),
  ]) {
    __resetReleaseCacheForTests();
    const { restore } = stub(res);
    try {
      assert.equal(await resolveAgentRelease(), null);
    } finally {
      restore();
    }
  }
});

test("a hit is kept; a miss is retried only after a short pause", async () => {
  let fail = true;
  const { seen, restore } = stub(() =>
    fail
      ? new Response("", { status: 503 })
      : new Response(`${"a".repeat(64)}  deplo-agent-linux-amd64\n`),
  );
  try {
    assert.equal(await resolveAgentRelease(), null);
    fail = false;
    assert.equal(await resolveAgentRelease(), null, "the miss is memoised");
    assert.equal(seen.length, 1);
    __resetReleaseCacheForTests();
    assert.ok(await resolveAgentRelease());
    assert.ok(await resolveAgentRelease());
    assert.equal(seen.length, 2, "a published tag is fetched once");
  } finally {
    restore();
  }
});
