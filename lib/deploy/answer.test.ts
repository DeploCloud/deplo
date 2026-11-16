import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ACME_PRIORITY,
  ANSWER_ACME_PRIORITY,
  MAX_ANSWER_SLOT,
  answerPorts,
  answerRoutes,
} from "./answer";
import { traefikRouterLabels } from "./routing";

test("an App's routes pass its hostnames through by SNI on websecure, and their checks on web, to its own ports", () => {
  assert.deepEqual(answerRoutes("prj_1", ["Shop.example.com"], 3), {
    tcp: {
      routers: {
        "deplo-answer-prj_1": {
          rule: "HostSNI(`shop.example.com`)",
          entryPoints: ["websecure"],
          service: "deplo-answer-prj_1",
          tls: { passthrough: true },
        },
      },
      services: {
        "deplo-answer-prj_1": {
          loadBalancer: {
            serversTransport: "deplo-answer@file",
            servers: [{ address: "deplo-answer:20006" }],
          },
        },
      },
    },
    http: {
      routers: {
        "deplo-answer-prj_1-acme": {
          rule: "Host(`shop.example.com`) && PathPrefix(`/.well-known/acme-challenge/`)",
          entryPoints: ["web"],
          service: "deplo-answer-prj_1-acme",
          priority: ANSWER_ACME_PRIORITY,
        },
      },
      services: {
        "deplo-answer-prj_1-acme": {
          loadBalancer: { servers: [{ url: "http://deplo-answer:20007" }] },
        },
      },
    },
  });
});

test("several hostnames of one App share its routers, each named once", () => {
  const r = answerRoutes("prj_1", ["www.shop.com", "shop.com", "shop.com"], 0);
  assert.equal(
    (r.tcp.routers["deplo-answer-prj_1"] as { rule: string }).rule,
    "HostSNI(`shop.com`) || HostSNI(`www.shop.com`)",
  );
  assert.equal(
    (r.http.routers["deplo-answer-prj_1-acme"] as { rule: string }).rule,
    "(Host(`shop.com`) || Host(`www.shop.com`)) && PathPrefix(`/.well-known/acme-challenge/`)",
  );
  assert.throws(() => answerRoutes("prj_1", [], 0));
});

test("every slot has two ports of its own, from 20000, inside the port range", () => {
  assert.deepEqual(answerPorts(0), { tls: 20000, web: 20001 });
  assert.deepEqual(answerPorts(1), { tls: 20002, web: 20003 });
  assert.ok(answerPorts(MAX_ANSWER_SLOT).web <= 65535);
  assert.ok(MAX_ANSWER_SLOT >= 200);
});

// The bypass on `web` hands the checks to whichever router outranks; Deplo's own challenge router must outrank
// every one Deplo writes, or another domain's check would land on its App.
test("Deplo's challenge router outranks every router Deplo writes, and an App's own check router outranks it", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-shop",
    defaultPort: 3000,
    certResolver: "letsencrypt",
    routes: [
      { name: "shop.example.com", port: null },
      {
        name: "shop.example.com",
        port: null,
        tls: false,
        pathPrefix: `/${"a".repeat(4000)}`,
      },
    ],
  });
  const priorities = labels
    .filter((l) => /\.priority=/.test(l))
    .map((l) => Number(l.split("=")[1]));
  assert.ok(priorities.length > 0);
  for (const p of priorities) assert.ok(p < ACME_PRIORITY, String(p));
  assert.ok(ANSWER_ACME_PRIORITY > ACME_PRIORITY);
  assert.ok(ANSWER_ACME_PRIORITY <= 2 ** 31 - 1);
});
