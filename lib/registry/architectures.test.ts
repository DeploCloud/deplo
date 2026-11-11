import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

import { imageArchitectures } from "./client";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const IMAGE = "1.1.1.1/acme/web:1";

function registry(routes: Record<string, unknown>) {
  const seen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    if (path === "/v2/") return new Response("{}");
    const body = routes[path];
    return body === undefined
      ? new Response(null, { status: 404 })
      : new Response(JSON.stringify(body));
  }) as typeof fetch;
  return seen;
}

test("an image published for several architectures lists each one once", async () => {
  registry({
    "/v2/acme/web/manifests/1": {
      manifests: [
        {
          digest: "sha256:a",
          platform: { os: "linux", architecture: "amd64" },
        },
        {
          digest: "sha256:b",
          platform: { os: "linux", architecture: "arm64", variant: "v8" },
        },
        { digest: "sha256:c", platform: { os: "linux", architecture: "arm" } },
        {
          digest: "sha256:d",
          platform: { os: "windows", architecture: "amd64" },
        },
        // The build record a registry lists beside the images themselves.
        {
          digest: "sha256:e",
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    },
  });
  assert.deepEqual(await imageArchitectures(IMAGE), ["amd64", "arm", "arm64"]);
});

test("an image published for one architecture says which, from its own description", async () => {
  const seen = registry({
    "/v2/acme/web/manifests/1": { config: { digest: "sha256:cfg" } },
    "/v2/acme/web/blobs/sha256%3Acfg": { os: "linux", architecture: "arm64" },
  });
  assert.deepEqual(await imageArchitectures(IMAGE), ["arm64"]);
  assert.deepEqual(seen, [
    "/v2/",
    "/v2/acme/web/manifests/1",
    "/v2/acme/web/blobs/sha256%3Acfg",
  ]);
});

test("a registry that does not answer, or answers nonsense, says nothing", async () => {
  registry({});
  assert.deepEqual(await imageArchitectures(IMAGE), []);
  registry({ "/v2/acme/web/manifests/1": { manifests: [{ digest: "x" }] } });
  assert.deepEqual(await imageArchitectures(IMAGE), []);
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  assert.deepEqual(await imageArchitectures(IMAGE), []);
  assert.deepEqual(await imageArchitectures(""), []);
});
