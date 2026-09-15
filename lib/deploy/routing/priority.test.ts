import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

function effectivePriority(labels: string[]): number {
  const prio = labels.find((l) => l.includes(".priority="));
  if (prio)
    return Number(prio.slice(prio.indexOf(".priority=") + ".priority=".length));
  const rule = labels.find((l) => l.includes(".rule="))!;
  return rule.slice(rule.indexOf(".rule=") + ".rule=".length).length;
}

test("a path router OUTRANKS a whole-host router on the same host (other app)", () => {
  const hostOnly = traefikRouterLabels({
    baseKey: "deplo-web",
    routes: [{ name: "app.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const pathRoute = traefikRouterLabels({
    baseKey: "deplo-api",
    routes: [
      { name: "app.com", port: null, pathPrefix: "/api", stripPrefix: true },
    ],
    defaultPort: 8080,
    certResolver: CR,
  });
  assert.ok(
    effectivePriority(pathRoute) > effectivePriority(hostOnly),
    `path router (${effectivePriority(pathRoute)}) must beat the whole-host router ` +
      `(${effectivePriority(hostOnly)}), else GET app.com/api hits the wrong app`,
  );
});

test("a path router outranks a whole-host router with MANY hosts (long rule)", () => {
  const manyHosts = traefikRouterLabels({
    baseKey: "deplo-web",
    routes: Array.from({ length: 40 }, (_, i) => ({
      name: `a-very-long-hostname-number-${i}.example.com`,
      port: null,
    })),
    defaultPort: 3000,
    certResolver: CR,
  });
  const pathRoute = traefikRouterLabels({
    baseKey: "deplo-api",
    routes: [
      { name: "app.com", port: null, pathPrefix: "/a", stripPrefix: true },
    ],
    defaultPort: 8080,
    certResolver: CR,
  });
  assert.ok(
    effectivePriority(manyHosts) > 100,
    "sanity: the long rule has a big default",
  );
  assert.ok(effectivePriority(pathRoute) > effectivePriority(manyHosts));
});

test("a LONGER path prefix outranks a shorter one on the same host", () => {
  const api = traefikRouterLabels({
    baseKey: "deplo-api",
    routes: [{ name: "app.com", port: null, pathPrefix: "/api" }],
    defaultPort: 8080,
    certResolver: CR,
  });
  const v1 = traefikRouterLabels({
    baseKey: "deplo-v1",
    routes: [{ name: "app.com", port: null, pathPrefix: "/api/v1" }],
    defaultPort: 9000,
    certResolver: CR,
  });
  assert.ok(effectivePriority(v1) > effectivePriority(api));
});

test("one app serving BOTH the bare host and a path on it ranks the path first", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "app.com", port: null },
      { name: "app.com", port: 8080, pathPrefix: "/api", stripPrefix: true },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const bareRule = labels.find((l) => l.endsWith(".rule=Host(`app.com`)"))!;
  const bareKey = bareRule.slice(
    "traefik.http.routers.".length,
    bareRule.indexOf(".rule="),
  );
  const pathRule = labels.find((l) => l.includes("PathPrefix(`/api`)"))!;
  const pathKey = pathRule.slice(
    "traefik.http.routers.".length,
    pathRule.indexOf(".rule="),
  );

  assert.ok(
    !labels.some((l) =>
      l.startsWith(`traefik.http.routers.${bareKey}.priority`),
    ),
  );
  const bare = "Host(`app.com`)".length;
  const path = Number(
    labels
      .find((l) => l.startsWith(`traefik.http.routers.${pathKey}.priority=`))!
      .split("=")[1],
  );
  assert.ok(path > bare, `path ${path} must beat bare host ${bare}`);
  assert.ok(
    labels.includes(
      `traefik.http.middlewares.${pathKey}-stripprefix.stripprefix.prefixes=/api`,
    ),
  );
  assert.ok(
    labels.includes(
      `traefik.http.routers.${pathKey}.middlewares=${pathKey}-stripprefix`,
    ),
  );
});
