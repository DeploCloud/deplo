import { test } from "node:test";
import assert from "node:assert/strict";

import { traefikRouterLabels } from "../routing";
import { CR } from "./routing-test-helpers";

test("redirectTo: a redirecting host gets its OWN router + redirectregex middleware", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "example.com", port: null },
      {
        name: "www.example.com",
        port: null,
        redirectTo: "https://example.com",
      },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(
    labels.includes("traefik.http.routers.deplo-app.rule=Host(`example.com`)"),
  );
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.equal(rules.length, 2, "two hosts, two routers");
  const wwwRule = rules.find((l) => l.includes("www.example.com"))!;
  const key = wwwRule.slice(
    "traefik.http.routers.".length,
    wwwRule.indexOf(".rule="),
  );
  assert.ok(
    key.startsWith("deplo-app__"),
    `redirect router keeps a suffixed key: ${key}`,
  );
  assert.deepEqual(
    labels.filter((l) => l.includes(`middlewares.${key}-redirect.`)),
    [
      `traefik.http.middlewares.${key}-redirect.redirectregex.regex=^https?://[^/]+(.*)`,
      `traefik.http.middlewares.${key}-redirect.redirectregex.replacement=https://example.com` +
        "$${1}",
      `traefik.http.middlewares.${key}-redirect.redirectregex.permanent=true`,
    ],
  );
  assert.ok(
    labels.includes(`traefik.http.routers.${key}.middlewares=${key}-redirect`),
    "the generated middleware is wired to the redirecting router",
  );
});

test("redirectTo: the redirect fires FIRST - ahead of basic auth and stripprefix", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      {
        name: "www.example.com",
        port: null,
        pathPrefix: "/api",
        stripPrefix: true,
        middlewares: ["compress"],
        redirectTo: "https://example.com",
      },
    ],
    defaultPort: 3000,
    certResolver: CR,
    basicAuth: { name: "auth", users: "u:h" },
  });
  const chain = labels.find((l) => l.includes(".middlewares="))!;
  const key = chain.slice(
    "traefik.http.routers.".length,
    chain.indexOf(".middlewares="),
  );
  assert.equal(
    chain,
    `traefik.http.routers.${key}.middlewares=${key}-redirect,${key}-stripprefix,auth,compress`,
  );
});

test("redirectTo: two hosts redirecting to the SAME target fold into one router", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      {
        name: "www.example.com",
        port: null,
        redirectTo: "https://example.com",
      },
      { name: "example.net", port: null, redirectTo: "https://example.com" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const rules = labels.filter((l) => l.includes(".rule="));
  assert.equal(rules.length, 1);
  assert.ok(
    rules[0].endsWith("Host(`www.example.com`) || Host(`example.net`)"),
  );
});

test("redirectTo: different targets never share a router key", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "www.a.com", port: null, redirectTo: "https://a.com" },
      { name: "www.b.com", port: null, redirectTo: "https://b.com" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  const keys = labels
    .filter((l) => l.includes(".rule="))
    .map((l) => l.slice("traefik.http.routers.".length, l.indexOf(".rule=")));
  assert.equal(new Set(keys).size, 2, "one router each, distinct keys");
});

test("redirectTo: a plain-HTTP host redirects to an https canonical", () => {
  const labels = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      {
        name: "www.example.com",
        port: null,
        tls: false,
        redirectTo: "https://example.com",
      },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.ok(labels.some((l) => l.endsWith(".entrypoints=web")));
  assert.ok(!labels.some((l) => l.includes(".tls=")));
  assert.ok(
    labels.some((l) =>
      l.endsWith(".redirectregex.replacement=https://example.com$${1}"),
    ),
  );
});

test("redirectTo: a non-absolute target is dropped, not guessed at", () => {
  const base = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "www.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const junk = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [
      { name: "www.example.com", port: null, redirectTo: "example.com" },
    ],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.deepEqual(
    junk,
    base,
    "a bare hostname is not an absolute redirect target",
  );
});

test("redirectTo: absent ⇒ byte-identical to the pre-redirect output", () => {
  const base = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null }],
    defaultPort: 3000,
    certResolver: CR,
  });
  const empty = traefikRouterLabels({
    baseKey: "deplo-app",
    routes: [{ name: "app.example.com", port: null, redirectTo: "" }],
    defaultPort: 3000,
    certResolver: CR,
  });
  assert.deepEqual(empty, base);
  assert.ok(!base.some((l) => l.includes("redirect")));
});
