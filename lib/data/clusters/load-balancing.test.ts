import { test } from "node:test";
import assert from "node:assert/strict";

import { cleanLoadBalancingMode } from "../../types/cluster";
import {
  ENTRANCE_MARGIN,
  LB_ANSWERS_EVERYWHERE,
  LB_KEEPS_DATA,
  LB_NO_CLOUDFLARE,
  balancedReplicas,
  chooseEntrance,
  lbOneServerNames,
  loadBalancingSkips,
  roomOf,
} from "./load-balancing";
import type { App } from "../../types/app";

const app = (over: Partial<App> = {}) =>
  ({
    volumes: [],
    ports: [],
    mounts: [],
    compose: null,
    source: "git",
    repo: "o/r",
    dockerImage: null,
    ...over,
  }) as unknown as App;

test("load balancing reaches an App on a Cloudflare domain that keeps nothing on its server", () => {
  assert.equal(loadBalancingSkips(app(), true), null);
  assert.equal(loadBalancingSkips(app(), false), LB_NO_CLOUDFLARE);
  assert.equal(
    loadBalancingSkips(
      app({ volumes: [{ type: "named", name: "data" } as never] }),
      true,
    ),
    LB_KEEPS_DATA,
  );
  assert.equal(
    loadBalancingSkips(app({ ports: [{ published: 22 } as never] }), true),
    LB_KEEPS_DATA,
    "a published port is held by one copy",
  );
});

test("a domain every server answers needs no Cloudflare once every server holds each name's certificate", () => {
  assert.equal(loadBalancingSkips(app(), false, true, []), null);
  assert.equal(
    loadBalancingSkips(app(), true, true, ["shop.example.com"]),
    lbOneServerNames(["shop.example.com"]),
  );
  assert.equal(loadBalancingSkips(app(), true, true), LB_ANSWERS_EVERYWHERE);
  // Data and compose stacks stay on one server, whatever their names.
  assert.equal(
    loadBalancingSkips(
      app({ volumes: [{ type: "named", name: "data" } as never] }),
      false,
      true,
      [],
    ),
    LB_KEEPS_DATA,
  );
  assert.equal(
    loadBalancingSkips(app({ source: "compose" }), false, true, []),
    LB_KEEPS_DATA,
  );
  assert.equal(
    lbOneServerNames(["a.example.com", "b.example.com"]),
    "It runs on one server: a.example.com and b.example.com have their certificate on that server only. Add the _acme-challenge record its domain offers, and from its next deploy it runs on every server.",
  );
});

test("a balanced App runs at least one replica on every server, more when it asks for more", () => {
  assert.equal(balancedReplicas(1, 3), 3);
  assert.equal(balancedReplicas(5, 3), 5);
});

test("a server's room is its free memory and idle processor, else what is placed on it", () => {
  assert.equal(roomOf({ memPct: 50, cpu: 10 }, 0.2), 0.7);
  assert.equal(roomOf(null, 0.25), 0.25);
  assert.equal(roomOf(null, null), 0);
});

test("visitors move to the most available server only when it has clearly more room", () => {
  const servers = [
    { serverId: "srv_a", room: 0.5 },
    { serverId: "srv_b", room: 0.6 },
  ];
  assert.equal(chooseEntrance(servers, null), "srv_b");
  assert.equal(chooseEntrance(servers, "srv_a"), "srv_a", "within the margin");
  assert.equal(
    chooseEntrance(
      [servers[0], { serverId: "srv_b", room: 0.5 + ENTRANCE_MARGIN + 0.01 }],
      "srv_a",
    ),
    "srv_b",
  );
  // The one taking them went away: the best of the rest.
  assert.equal(chooseEntrance([servers[1]], "srv_a"), "srv_b");
  assert.equal(chooseEntrance([], "srv_a"), null);
});

test("only the two modes are accepted", () => {
  assert.equal(cleanLoadBalancingMode("nearest"), "nearest");
  assert.equal(cleanLoadBalancingMode("most_available"), "most_available");
  assert.throws(() => cleanLoadBalancingMode("round_robin"));
});
