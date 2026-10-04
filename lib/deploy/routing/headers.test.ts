import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

test("security headers become one headers middleware on the route's own router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, securityHeaders: true }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const router = labels
    .find((l) => l.endsWith(".rule=Host(`app.com`)"))!
    .split(".")[3];
  const at = `traefik.http.middlewares.${router}-headers.headers`;
  assert.ok(
    labels.includes(`${at}.contenttypenosniff=true`),
    labels.join("\n"),
  );
  assert.ok(labels.includes(`${at}.customframeoptionsvalue=SAMEORIGIN`));
  assert.ok(
    labels.includes(`${at}.referrerpolicy=strict-origin-when-cross-origin`),
  );
  assert.ok(!labels.some((l) => l.includes("accesscontrol")));
  assert.ok(
    labels.includes(
      `traefik.http.routers.${router}.middlewares=${router}-headers`,
    ),
  );
});

test("allowed origins add the CORS headers, with or without the security set", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      {
        name: "api.com",
        port: null,
        corsOrigins: ["https://app.acme.com", "https://admin.acme.com"],
      },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.some((l) =>
      l.endsWith(
        ".headers.accesscontrolalloworiginlist=https://app.acme.com,https://admin.acme.com",
      ),
    ),
    labels.join("\n"),
  );
  assert.ok(labels.some((l) => l.endsWith(".headers.addvaryheader=true")));
  assert.ok(!labels.some((l) => l.includes("contenttypenosniff")));
});

test("a route with neither setting renders exactly as before", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.com", port: null, securityHeaders: false }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(!labels.some((l) => l.includes(".headers.")));
  assert.ok(
    labels.includes("traefik.http.routers.deplo-app.rule=Host(`app.com`)"),
  );
});

test("two hosts with different header settings never share a router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "a.com", port: null, securityHeaders: true },
      { name: "b.com", port: null, securityHeaders: false },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.equal(rules.length, 2, rules.join("\n"));
});
