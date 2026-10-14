import { test } from "node:test";
import assert from "node:assert/strict";

import type { RerouteRequest } from "../../agent/gen/agent";
import { stackFilesDir } from "../../deploy/deploy-key";
import type { AgentChannel } from "./mtls-channel";
import { stackRpc } from "./stack-rpc";

type Reply = (err: Error | null, resp: { ok: boolean; error: string }) => void;

test("reroute: every mount out of the app's files goes to the agent to check", async () => {
  let sent: RerouteRequest | undefined;
  const channel = {
    assertNetworkCapable: async () => {},
    client: {
      reroute: (req: RerouteRequest, _md: unknown, _o: unknown, cb: Reply) => {
        sent = req;
        cb(null, { ok: true, error: "" });
      },
    },
  } as unknown as AgentChannel;
  const files = stackFilesDir("web");
  await stackRpc(channel).reroute({
    slug: "web",
    composeYaml: `services:\n  web:\n    image: nginx\n    volumes:\n      - ${files}/data:/data\n      - /srv/media:/media\n`,
    env: {},
    mounts: [],
    network: "deplo-team-team_a",
  });
  assert.deepEqual(sent?.filesBindSources, ["data"]);
});
