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
});
