import { test } from "node:test";
import assert from "node:assert/strict";

import { orderDeployRoutes } from "./build";
import { defaultRoute, type RoutableDomain } from "../data/domains";

/**
 * The route set a production deploy bakes into its Traefik labels.
 *
 * The contract that broke: a path prefix lets several domain rows share ONE
 * hostname (uniqueness is on `(name, path)`), so `app.com` and `app.com` + `/api`
 * are two distinct routes. The assembly step used to drop "every row whose name
 * is the primary's", which deleted the `/api` row before it ever reached the
 * router grammar — the user set a path, redeployed, and nothing happened.
 */

/** A valid, routable row as `routableRoutes` returns it. */
function route(
  name: string,
  extra: Partial<RoutableDomain> = {},
): RoutableDomain {
  return { ...defaultRoute(name), ...extra };
}

test("a path row on the PRIMARY's hostname survives the deploy", () => {
  const valid = [
    route("app.com"),
    route("app.com", { port: 8080, pathPrefix: "/api", stripPrefix: true }),
  ];
  const out = orderDeployRoutes(valid, "app.com");

  assert.equal(out.length, 2, "the /api row must not be dropped");
  assert.equal(out[0], valid[0], "the primary row still leads");
  assert.deepEqual(
    out.map((r) => r.pathPrefix),
    ["", "/api"],
  );
  assert.equal(out[1].stripPrefix, true);
  assert.equal(out[1].port, 8080);
});

test("several path rows on one hostname all survive", () => {
  const valid = [
    route("app.com"),
    route("app.com", { port: 8080, pathPrefix: "/api" }),
    route("app.com", { port: 9000, pathPrefix: "/admin" }),
  ];
  const out = orderDeployRoutes(valid, "app.com");
  assert.deepEqual(
    out.map((r) => r.pathPrefix).sort(),
    ["", "/admin", "/api"],
  );
});

test("the primary row leads even when it is the one carrying the path", () => {
  // Only row is `app.com` + `/api` and it is primary: it must keep its path.
  const valid = [route("app.com", { port: 8080, pathPrefix: "/api", stripPrefix: true })];
  const out = orderDeployRoutes(valid, "app.com");
  assert.equal(out.length, 1);
  assert.equal(out[0].pathPrefix, "/api");
  assert.equal(out[0].stripPrefix, true);
});

test("distinct hostnames are all kept, primary first (long-standing behaviour)", () => {
  const valid = [route("b.com"), route("app.com"), route("c.com")];
  const out = orderDeployRoutes(valid, "app.com");
  assert.deepEqual(
    out.map((r) => r.name),
    ["app.com", "b.com", "c.com"],
  );
});

test("a not-yet-valid primary is added as a synthetic route, never duplicated", () => {
  // The primary (`app.com`) has no valid row; `other.com` does. The synthetic
  // fallback leads and the valid row is kept.
  const valid = [route("other.com")];
  const out = orderDeployRoutes(valid, "app.com");
  assert.deepEqual(
    out.map((r) => r.name),
    ["app.com", "other.com"],
  );
  assert.equal(out[0].pathPrefix, "", "the synthetic fallback routes the whole host");
});

// An UNVERIFIED primary is still routed (so a brand-new app answers on it), and
// it must be routed as the user configured it. Building that fallback from
// `defaultRoute` flattened the row to whole-host-HTTPS-on-the-default-port, so a
// first domain added WITH a path came up serving the whole host and the path
// silently did nothing until someone happened to verify it.

test("an unverified primary keeps its OWN path/strip/port, not defaults", () => {
  const stored = route("app.com", {
    port: 8080,
    pathPrefix: "/api",
    stripPrefix: true,
  });
  const out = orderDeployRoutes([], "app.com", stored);
  assert.equal(out.length, 1);
  assert.equal(out[0].pathPrefix, "/api", "the path must survive the fallback");
  assert.equal(out[0].stripPrefix, true);
  assert.equal(out[0].port, 8080);
});

test("an unverified primary keeps its config alongside other valid rows", () => {
  const stored = route("app.com", { port: 8080, pathPrefix: "/api", stripPrefix: true });
  const out = orderDeployRoutes([route("other.com")], "app.com", stored);
  assert.deepEqual(
    out.map((r) => r.name),
    ["app.com", "other.com"],
  );
  assert.equal(out[0].pathPrefix, "/api");
  assert.equal(out[0].stripPrefix, true);
});

test("no stored row for the primary ⇒ still falls back to a bare defaultRoute", () => {
  const out = orderDeployRoutes([], "app.com", null);
  assert.equal(out.length, 1);
  assert.equal(out[0].name, "app.com");
  assert.equal(out[0].pathPrefix, "");
});

test("no valid rows ⇒ just the pending primary; no primary at all ⇒ unrouted", () => {
  assert.deepEqual(
    orderDeployRoutes([], "app.com").map((r) => r.name),
    ["app.com"],
  );
  assert.deepEqual(orderDeployRoutes([], ""), []);
});
