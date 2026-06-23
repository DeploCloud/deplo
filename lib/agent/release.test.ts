import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveLatestAgentRelease,
  refreshAgentRelease,
  __resetReleaseCacheForTests,
} from "./release";

/**
 * resolveLatestAgentRelease is the single source for "which agent release a new
 * server installs": it reads the latest GitHub release, parses the checksums.txt
 * asset, and returns a per-arch { url, sha256 } map. These tests stub fetch to
 * pin the contract: a leading `v` is stripped, the checksum comes from the
 * checksums asset (not the API), and an unverifiable/empty release collapses to
 * null so callers degrade gracefully.
 */

interface FetchStub {
  release: unknown;
  releaseStatus?: number;
  checksums?: string;
  checksumsStatus?: number;
}

function stub({ release, releaseStatus = 200, checksums, checksumsStatus = 200 }: FetchStub) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      return new Response(JSON.stringify(release), { status: releaseStatus });
    }
    if (url.includes("checksums")) {
      return new Response(checksums ?? "", { status: checksumsStatus });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = orig;
  };
}

afterEach(() => __resetReleaseCacheForTests());

test("resolves version (v stripped) and per-arch url+sha from checksums.txt", async () => {
  const restore = stub({
    release: {
      tag_name: "v1.4.2",
      assets: [
        { name: "deplo-agent-linux-amd64", browser_download_url: "https://x/amd64" },
        { name: "deplo-agent-linux-arm64", browser_download_url: "https://x/arm64" },
        { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
      ],
    },
    checksums:
      `${"a".repeat(64)}  deplo-agent-linux-amd64\n` +
      `${"b".repeat(64)} *deplo-agent-linux-arm64\n`,
  });
  __resetReleaseCacheForTests();
  try {
    const rel = await resolveLatestAgentRelease();
    assert.ok(rel);
    assert.equal(rel!.version, "1.4.2");
    assert.deepEqual(rel!.binaries.amd64, { url: "https://x/amd64", sha256: "a".repeat(64) });
    assert.deepEqual(rel!.binaries.arm64, { url: "https://x/arm64", sha256: "b".repeat(64) });
  } finally {
    restore();
  }
});

test("a single published arch is fine; the missing one is null", async () => {
  const restore = stub({
    release: {
      tag_name: "2.0.0",
      assets: [
        { name: "deplo-agent-linux-amd64", browser_download_url: "https://x/amd64" },
        { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
      ],
    },
    checksums: `${"c".repeat(64)}  deplo-agent-linux-amd64\n`,
  });
  __resetReleaseCacheForTests();
  try {
    const rel = await resolveLatestAgentRelease();
    assert.ok(rel);
    assert.deepEqual(rel!.binaries.amd64, { url: "https://x/amd64", sha256: "c".repeat(64) });
    assert.equal(rel!.binaries.arm64, null);
  } finally {
    restore();
  }
});

test("null when the checksums asset is absent (can't pin integrity)", async () => {
  const restore = stub({
    release: {
      tag_name: "1.0.0",
      assets: [{ name: "deplo-agent-linux-amd64", browser_download_url: "https://x/amd64" }],
    },
  });
  __resetReleaseCacheForTests();
  try {
    assert.equal(await resolveLatestAgentRelease(), null);
  } finally {
    restore();
  }
});

test("null when GitHub has no release yet (404)", async () => {
  const restore = stub({ release: {}, releaseStatus: 404 });
  __resetReleaseCacheForTests();
  try {
    assert.equal(await resolveLatestAgentRelease(), null);
  } finally {
    restore();
  }
});

test("null when an asset has no matching checksum line", async () => {
  const restore = stub({
    release: {
      tag_name: "1.0.0",
      assets: [
        { name: "deplo-agent-linux-amd64", browser_download_url: "https://x/amd64" },
        { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
      ],
    },
    checksums: `${"d".repeat(64)}  some-other-file\n`,
  });
  __resetReleaseCacheForTests();
  try {
    // amd64 has no checksum -> unresolvable -> no usable arch -> null.
    assert.equal(await resolveLatestAgentRelease(), null);
  } finally {
    restore();
  }
});

/**
 * A stub whose served "latest" can change between calls and that counts how many
 * times the release endpoint was hit — so a test can assert the memo coalesces
 * within the TTL and that refreshAgentRelease() forces a fresh hit that surfaces
 * a newly-published version. `version()` is read at fetch time, so flipping the
 * variable mid-test models a release published while the process was running.
 */
function countingStub(version: () => string) {
  const orig = globalThis.fetch;
  let releaseHits = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/releases/latest")) {
      releaseHits++;
      const v = version();
      return new Response(
        JSON.stringify({
          tag_name: `v${v}`,
          assets: [
            { name: "deplo-agent-linux-amd64", browser_download_url: "https://x/amd64" },
            { name: "checksums.txt", browser_download_url: "https://x/checksums.txt" },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("checksums")) {
      return new Response(`${"a".repeat(64)}  deplo-agent-linux-amd64\n`, { status: 200 });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return { hits: () => releaseHits, restore: () => void (globalThis.fetch = orig) };
}

test("memo coalesces repeated resolves within the TTL (one GitHub hit)", async () => {
  const s = countingStub(() => "1.0.0");
  __resetReleaseCacheForTests();
  try {
    const a = await resolveLatestAgentRelease();
    const b = await resolveLatestAgentRelease();
    assert.equal(a!.version, "1.0.0");
    assert.equal(b!.version, "1.0.0");
    // Second resolve served from the memo — no extra GitHub call.
    assert.equal(s.hits(), 1);
  } finally {
    s.restore();
  }
});

test("refreshAgentRelease busts the memo and surfaces a newly-published version", async () => {
  // This is the "Check for updates" regression: without busting the shared memo,
  // a release cut after the first resolve would stay hidden until the TTL lapsed,
  // so the operator's click could not flip an outdated badge.
  let latest = "1.0.0";
  const s = countingStub(() => latest);
  __resetReleaseCacheForTests();
  try {
    const before = await resolveLatestAgentRelease();
    assert.equal(before!.version, "1.0.0");

    // A new agent release is published while this process is running.
    latest = "1.5.0";

    // Stale read still served from the memo (proves the memo was real)...
    assert.equal((await resolveLatestAgentRelease())!.version, "1.0.0");
    assert.equal(s.hits(), 1);

    // ...until the operator forces a refresh, which re-hits GitHub and returns
    // the fresh version AND re-populates the memo for the render that follows.
    const refreshed = await refreshAgentRelease();
    assert.equal(refreshed!.version, "1.5.0");
    assert.equal(s.hits(), 2);
    assert.equal((await resolveLatestAgentRelease())!.version, "1.5.0");
    assert.equal(s.hits(), 2); // re-populated — no third hit
  } finally {
    s.restore();
  }
});
