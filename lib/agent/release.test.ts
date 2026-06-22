import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  resolveLatestAgentRelease,
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
