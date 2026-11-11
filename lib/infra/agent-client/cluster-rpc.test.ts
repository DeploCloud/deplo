import { test } from "node:test";
import assert from "node:assert/strict";

import { clusterRpc } from "./cluster-rpc";
import type { AgentChannel } from "./mtls-channel";

// The wire shape: what each call sends, what it hands back, and that it has a deadline.
test("each call sends its fields and answers with the agent's", async () => {
  const sent: Record<string, { req: unknown; ms: number }> = {};
  const unary =
    (name: string, answer: unknown) =>
    (
      req: unknown,
      _md: unknown,
      opts: { deadline: Date },
      cb: (e: null, r: unknown) => void,
    ) => {
      sent[name] = { req, ms: opts.deadline.getTime() - Date.now() };
      cb(null, answer);
    };
  const rpc = clusterRpc({
    client: {
      installCluster: unary("install", { version: "1.0.0", running: true }),
      removeCluster: unary("remove", { removed: true }),
      clusterStatus: unary("status", {
        installed: true,
        running: false,
        version: "1.0.0",
        relay: true,
        member: true,
        relayLinks: 2,
      }),
      setClusterMember: unary("member", { member: true, relayLinks: 1 }),
      clusterCall: unary("call", { payload: new Uint8Array([7]) }),
    },
  } as unknown as AgentChannel);

  const bins = { amd64: { url: "u", sha256: "s" } };
  assert.deepEqual(await rpc.installCluster("1.0.0", bins, true), {
    version: "1.0.0",
    running: true,
  });
  assert.deepEqual(sent.install.req, {
    version: "1.0.0",
    binaries: bins,
    relay: true,
  });
  assert.deepEqual(await rpc.removeCluster(), { removed: true });
  assert.deepEqual(await rpc.clusterStatus(), {
    installed: true,
    running: false,
    version: "1.0.0",
    relay: true,
    member: true,
    relayLinks: 2,
  });
  assert.deepEqual(
    await rpc.setClusterMember(true, ["https://r.example.com"]),
    {
      member: true,
      relayLinks: 1,
    },
  );
  assert.deepEqual(sent.member.req, {
    member: true,
    relays: ["https://r.example.com"],
  });
  assert.deepEqual(
    [...(await rpc.clusterCall("place", new Uint8Array([1])))],
    [7],
  );
  assert.deepEqual(sent.call.req, {
    method: "place",
    payload: new Uint8Array([1]),
  });
  for (const { ms } of Object.values(sent)) assert.ok(ms > 0 && ms <= 180_000);
  // Deplo's beat is given up on before the next one is due.
  await rpc.clusterCall("leader.beat", new Uint8Array([1]), 4_000);
  assert.ok(sent.call.ms > 0 && sent.call.ms <= 4_000);
});

test("an image copy names the image, the target and how many releases to keep, with room for a long transfer", async () => {
  let sent: { req: unknown; ms: number } | null = null;
  const rpc = clusterRpc({
    client: {
      copyClusterImage: (
        req: unknown,
        _md: unknown,
        opts: { deadline: Date },
        cb: (e: null, r: unknown) => void,
      ) => {
        sent = { req, ms: opts.deadline.getTime() - Date.now() };
        cb(null, { alreadyPresent: false, bytes: "42", pruned: ["deplo/a:1"] });
      },
    },
  } as unknown as AgentChannel);

  assert.deepEqual(await rpc.copyClusterImage("deplo/a:2", "f".repeat(64), 2), {
    alreadyPresent: false,
    bytes: 42,
    pruned: ["deplo/a:1"],
  });
  const got = sent as unknown as { req: unknown; ms: number };
  assert.deepEqual(got.req, {
    imageRef: "deplo/a:2",
    targetFingerprint: "f".repeat(64),
    keep: 2,
  });
  assert.ok(got.ms > 30 * 60_000);
});
