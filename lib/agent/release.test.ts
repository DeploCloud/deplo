import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  AGENT_REPO,
  FALLBACK_AGENT_VERSION,
  resolveLatestAgentRelease,
  refreshAgentRelease,
  __resetReleaseCacheForTests,
} from "./release";

interface FetchStub {
  release: unknown;
  releaseStatus?: number;
  checksums?: string;
  checksumsStatus?: number;
}

function stub({
  release,
  releaseStatus = 200,
  checksums,
  checksumsStatus = 200,
}: FetchStub) {
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
        {
          name: "deplo-agent-linux-amd64",
          browser_download_url: "https://x/amd64",
        },
        {
          name: "deplo-agent-linux-arm64",
          browser_download_url: "https://x/arm64",
        },
        {
          name: "checksums.txt",
          browser_download_url: "https://x/checksums.txt",
        },
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
    assert.deepEqual(rel!.binaries.amd64, {
      url: "https://x/amd64",
      sha256: "a".repeat(64),
    });
    assert.deepEqual(rel!.binaries.arm64, {
      url: "https://x/arm64",
      sha256: "b".repeat(64),
    });
  } finally {
    restore();
  }
});

test("a single published arch is fine; the missing one is null", async () => {
  const restore = stub({
    release: {
      tag_name: "2.0.0",
      assets: [
        {
          name: "deplo-agent-linux-amd64",
          browser_download_url: "https://x/amd64",
        },
        {
          name: "checksums.txt",
          browser_download_url: "https://x/checksums.txt",
        },
      ],
    },
    checksums: `${"c".repeat(64)}  deplo-agent-linux-amd64\n`,
  });
  __resetReleaseCacheForTests();
  try {
    const rel = await resolveLatestAgentRelease();
    assert.ok(rel);
    assert.deepEqual(rel!.binaries.amd64, {
      url: "https://x/amd64",
      sha256: "c".repeat(64),
    });
    assert.equal(rel!.binaries.arm64, null);
  } finally {
    restore();
  }
});

test("null when the checksums asset is absent (can't pin integrity)", async () => {
  const restore = stub({
    release: {
      tag_name: "1.0.0",
      assets: [
        {
          name: "deplo-agent-linux-amd64",
          browser_download_url: "https://x/amd64",
        },
      ],
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
        {
          name: "deplo-agent-linux-amd64",
          browser_download_url: "https://x/amd64",
        },
        {
          name: "checksums.txt",
          browser_download_url: "https://x/checksums.txt",
        },
      ],
    },
    checksums: `${"d".repeat(64)}  some-other-file\n`,
  });
  __resetReleaseCacheForTests();
  try {
    assert.equal(await resolveLatestAgentRelease(), null);
  } finally {
    restore();
  }
});

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
            {
              name: "deplo-agent-linux-amd64",
              browser_download_url: "https://x/amd64",
            },
            {
              name: "checksums.txt",
              browser_download_url: "https://x/checksums.txt",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (url.includes("checksums")) {
      return new Response(`${"a".repeat(64)}  deplo-agent-linux-amd64\n`, {
        status: 200,
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return {
    hits: () => releaseHits,
    restore: () => void (globalThis.fetch = orig),
  };
}

test("memo coalesces repeated resolves within the TTL (one GitHub hit)", async () => {
  const s = countingStub(() => "1.0.0");
  __resetReleaseCacheForTests();
  try {
    const a = await resolveLatestAgentRelease();
    const b = await resolveLatestAgentRelease();
    assert.equal(a!.version, "1.0.0");
    assert.equal(b!.version, "1.0.0");
    assert.equal(s.hits(), 1);
  } finally {
    s.restore();
  }
});

test("refreshAgentRelease busts the memo and surfaces a newly-published version", async () => {
  let latest = "1.0.0";
  const s = countingStub(() => latest);
  __resetReleaseCacheForTests();
  try {
    const before = await resolveLatestAgentRelease();
    assert.equal(before!.version, "1.0.0");

    latest = "1.5.0";

    assert.equal((await resolveLatestAgentRelease())!.version, "1.0.0");
    assert.equal(s.hits(), 1);

    const refreshed = await refreshAgentRelease();
    assert.equal(refreshed!.version, "1.5.0");
    assert.equal(s.hits(), 2);
    assert.equal((await resolveLatestAgentRelease())!.version, "1.5.0");
    assert.equal(s.hits(), 2);
  } finally {
    s.restore();
  }
});

test("a resolved release keeps being served through a GitHub blip", async () => {
  const good = stub({
    release: {
      tag_name: "v2.0.0",
      assets: [
        {
          name: "deplo-agent-linux-amd64",
          browser_download_url: "https://x/amd64",
        },
        { name: "checksums.txt", browser_download_url: "https://x/checksums" },
      ],
    },
    checksums: `${"a".repeat(64)}  deplo-agent-linux-amd64\n`,
  });
  assert.equal((await resolveLatestAgentRelease())?.version, "2.0.0");
  good();

  const limited = stub({ release: {}, releaseStatus: 403 });
  const after = await refreshAgentRelease();
  limited();
  assert.equal(
    after?.version,
    "2.0.0",
    "the installer still has a release to render",
  );
});

test("the pinned release resolves without the API when the budget is spent", async () => {
  const orig = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    seen.push(url);
    if (url.includes("api.github.com"))
      return new Response("rate limit exceeded", { status: 403 });
    if (url.endsWith("/checksums.txt"))
      return new Response(
        `${"c".repeat(64)}  deplo-agent-linux-amd64\n` +
          `${"d".repeat(64)}  deplo-agent-linux-arm64\n`,
        { status: 200 },
      );
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  __resetReleaseCacheForTests();
  try {
    const rel = await resolveLatestAgentRelease();
    assert.equal(rel?.version, FALLBACK_AGENT_VERSION);
    assert.deepEqual(rel!.binaries.amd64, {
      url: `https://github.com/${AGENT_REPO}/releases/download/v${FALLBACK_AGENT_VERSION}/deplo-agent-linux-amd64`,
      sha256: "c".repeat(64),
    });
    assert.ok(
      seen.some((u) => u.includes("api.github.com")),
      "the API is still asked first - the fallback is a fallback",
    );
  } finally {
    globalThis.fetch = orig;
  }
});

test("no release at all is still null, so no unverified binary is served", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("nope", { status: 404 })) as typeof fetch;
  __resetReleaseCacheForTests();
  try {
    assert.equal(await resolveLatestAgentRelease(), null);
  } finally {
    globalThis.fetch = orig;
  }
});
