import { test } from "node:test";
import assert from "node:assert/strict";

import { previewCommentBody, retryTransient } from "./preview-comment";
import { TransientGithubError } from "../github/app";

/**
 * The sticky pull request comment, state by state. What matters is that a state
 * with no working URL never prints one.
 */

const at = {
  url: "http://blog-pr-42-abc123-0a000001.nip.io",
  host: "blog-pr-42-abc123-0a000001.nip.io",
  buildLogUrl: "https://deplo.example.com/acme/apps/blog/deployments/dpl_1",
};

test("ready is the only state that links the preview", () => {
  const ready = previewCommentBody({ state: { kind: "ready" }, ...at });
  assert.ok(ready.includes(`[${at.host}](${at.url})`));
  for (const state of [
    { kind: "building" as const },
    { kind: "failed" as const },
    { kind: "destroyed" as const },
    { kind: "awaiting-approval" as const },
    { kind: "evicted" as const, max: 3 },
    { kind: "refused" as const, reason: "no" },
  ]) {
    const body = previewCommentBody({ state, ...at });
    assert.ok(!body.includes(at.url), `${state.kind} must not link a dead URL`);
    assert.ok(body.includes("Not deployed") || body.includes("Waiting for"));
  }
});

test("an evicted preview says which limit stopped it and how to get it back", () => {
  const body = previewCommentBody({
    state: { kind: "evicted", max: 3 },
    ...at,
  });
  assert.ok(body.includes("| Stopped |"));
  assert.ok(body.includes("limit of 3"));
  assert.ok(body.includes("Redeploy"));
});

test("the build log link is optional and never a placeholder host", () => {
  const none = previewCommentBody({
    state: { kind: "ready" },
    ...at,
    buildLogUrl: null,
  });
  assert.ok(!none.includes("Build logs"));
  const some = previewCommentBody({ state: { kind: "ready" }, ...at });
  assert.ok(some.includes(`[Build logs](${at.buildLogUrl})`));
});

test("a transient GitHub failure is asked again, a definitive one is not", async () => {
  const waits: number[] = [];
  const sleep = async (ms: number) => {
    waits.push(ms);
  };
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) throw new TransientGithubError("502");
    return 42;
  };
  assert.equal(await retryTransient(flaky, [1, 2, 3], sleep), 42);
  assert.equal(calls, 3);
  assert.deepEqual(waits, [1, 2]);

  let permanent = 0;
  await assert.rejects(
    () =>
      retryTransient(
        async () => {
          permanent++;
          throw new Error("403");
        },
        [1, 2],
        sleep,
      ),
    /403/,
  );
  assert.equal(permanent, 1, "a refusal is not asked twice");

  let exhausted = 0;
  await assert.rejects(
    () =>
      retryTransient(
        async () => {
          exhausted++;
          throw new TransientGithubError("still down");
        },
        [1],
        sleep,
      ),
    /still down/,
  );
  assert.equal(exhausted, 2, "one retry per delay, then give up");
});
