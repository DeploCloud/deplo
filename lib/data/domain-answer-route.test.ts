import { test } from "node:test";
import assert from "node:assert/strict";

import { toRoutableDomain } from "./domains/routes";
import { traefikRouterLabels } from "../deploy/routing";
import type { Domain } from "../types/domain";

const domain = (over: Partial<Domain> = {}): Domain => ({
  id: "dom_1",
  appId: "prj_1",
  name: "shop.example.com",
  status: "valid",
  primary: true,
  redirectTo: null,
  ssl: true,
  certProvider: "letsencrypt",
  createdAt: "2026-01-01T00:00:00.000Z",
  ...over,
});

const labelsOf = (d: Domain) =>
  traefikRouterLabels({
    baseKey: "deplo-shop",
    defaultPort: 3000,
    certResolver: "letsencrypt",
    routes: [toRoutableDomain(d)],
  });

// Outside the feature nothing about a domain's routers moves: same labels, same certificate resolver.
test("a domain that does not answer everywhere keeps exactly the routers it had", () => {
  const labels = labelsOf(domain());
  assert.deepEqual(labels, labelsOf(domain({ answersEverywhere: false })));
  assert.ok(
    labels.includes("traefik.http.routers.deplo-shop.entrypoints=websecure"),
  );
  assert.ok(
    labels.includes(
      "traefik.http.routers.deplo-shop.tls.certresolver=letsencrypt",
    ),
  );
  assert.ok(!labels.some((l) => l.includes("answer")));
});

// c41: on websecure too, the App's own router won over its server's passthrough to the agent, so that server's
// visitors reached the container straight: one 502 at each recreate, a stale copy answering after a hang.
test("an HTTPS domain that answers everywhere is routed on the internal entrypoint only, with its certificate", () => {
  const labels = labelsOf(domain({ answersEverywhere: true }));
  const eps = labels.find((l) => /\.entrypoints=/.test(l));
  assert.equal(eps?.split("=")[1], "answer");
  assert.ok(labels.some((l) => l.endsWith(".tls.certresolver=letsencrypt")));
});

test("a plain-HTTP domain is never routed on the internal entrypoint", () => {
  const labels = labelsOf(
    domain({ answersEverywhere: true, certProvider: "none" }),
  );
  assert.ok(!labels.some((l) => l.includes("answer")));
});
