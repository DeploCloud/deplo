import { test } from "node:test";
import assert from "node:assert/strict";

import { buildComposeStack } from "./render";
import {
  WEB_API_COMPOSE,
  buildDoc,
  labelsOf,
  route,
} from "./stack-test-helpers";

test("Traefik labels + Deplo network applied alongside the preserved ports", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
    ports:
      - "8080:80"
`);
  const labels = labelsOf(doc.services.web);
  assert.ok(
    labels.includes("traefik.docker.network=deplo-team-team_test"),
    "Traefik is pinned to the stack's OWN network, not the platform's",
  );
  assert.ok(
    labels.some((l) =>
      /^traefik\.http\.services\.deplo-demo-web-[^.]*\.loadbalancer\.server\.port=80$/.test(
        l,
      ),
    ),
  );
  assert.ok((doc.services.web.networks as string[]).includes("deplo"));
  assert.deepEqual(doc.services.web.ports, ["8080:80"]);
});

test("each domain route becomes one router to its named service", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [
      route("web.1.2.3.4.nip.io", "web", 80),
      route("api.1.2.3.4.nip.io", "api", 8080),
    ],
  });
  const web = labelsOf(doc.services.web);
  const api = labelsOf(doc.services.api);
  assert.ok(web.some((l) => l.includes("Host(`web.1.2.3.4.nip.io`)")));
  assert.ok(web.some((l) => /loadbalancer\.server\.port=80$/.test(l)));
  assert.ok(api.some((l) => l.includes("Host(`api.1.2.3.4.nip.io`)")));
  assert.ok(api.some((l) => /loadbalancer\.server\.port=8080$/.test(l)));
  assert.ok((doc.services.web.networks as string[]).includes("deplo"));
  assert.ok((doc.services.api.networks as string[]).includes("deplo"));
});

test("a route with null port falls back to the service's compose port", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [route("api.1.2.3.4.nip.io", "api", null)],
  });
  const api = labelsOf(doc.services.api);
  assert.ok(api.some((l) => /loadbalancer\.server\.port=8080$/.test(l)));
});

test("a route whose service is null is skipped (no router emitted)", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [route("orphan.1.2.3.4.nip.io", null as unknown as string)],
  });
  const all = [...labelsOf(doc.services.web), ...labelsOf(doc.services.api)];
  assert.ok(!all.some((l) => l.includes("orphan.1.2.3.4.nip.io")));
});

test("a route whose service is absent from the stack is skipped", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [route("ghost.1.2.3.4.nip.io", "nonesuch", 1234)],
  });
  const all = [...labelsOf(doc.services.web), ...labelsOf(doc.services.api)];
  assert.ok(!all.some((l) => l.includes("ghost.1.2.3.4.nip.io")));
});

test("no domain routes ⇒ NO Traefik routers (the stack is built but unrouted)", () => {
  const doc = buildDoc(WEB_API_COMPOSE, { domainRoutes: [] });
  const all = [...labelsOf(doc.services.web), ...labelsOf(doc.services.api)];
  assert.ok(all.includes("deplo.managed=true"));
  assert.ok(!all.some((l) => l.startsWith("traefik.http.routers.")));
  assert.ok(!all.some((l) => l.includes(".rule=")));
});

test("a user-authored traefik.* label is stripped; Deplo's own routers survive", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    labels:
      - traefik.http.routers.evil.rule=Host(\`victim.com\`)
      - traefik.http.routers.evil.priority=1000
      - com.example.keep=yes
`,
    { domainRoutes: [route("real.1.2.3.4.nip.io", "web", 80)] },
  );
  const labels = labelsOf(doc.services.web);
  assert.ok(!labels.some((l) => l.includes("victim.com")));
  assert.ok(!labels.some((l) => l.includes("routers.evil")));
  assert.ok(labels.includes("com.example.keep=yes"));
  assert.ok(labels.some((l) => l.includes("Host(`real.1.2.3.4.nip.io`)")));
  assert.ok(
    labels.includes("traefik.docker.network=deplo-team-team_test"),
    "Traefik is pinned to the stack's OWN network, not the platform's",
  );
});

test("a label whose KEY comes from a variable is dropped, router and all", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    labels:
      - \${LBL}
      - com.example.version=\${TAG}
`,
    { domainRoutes: [route("real.1.2.3.4.nip.io", "web", 80)] },
  );
  const labels = labelsOf(doc.services.web);
  assert.ok(!labels.some((l) => l.startsWith("${LBL}")));
  assert.ok(labels.includes("com.example.version=${TAG}"));
});

test("a user traefik.* label in MAP form is stripped too", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    labels:
      traefik.http.routers.evil.rule: Host(\`victim.com\`)
      com.example.keep: yes
`,
    { domainRoutes: [route("real.1.2.3.4.nip.io", "web", 80)] },
  );
  const labels = labelsOf(doc.services.web);
  assert.ok(!labels.some((l) => l.includes("victim.com")));
  assert.ok(labels.some((l) => l.startsWith("com.example.keep=")));
  assert.ok(labels.some((l) => l.includes("Host(`real.1.2.3.4.nip.io`)")));
});

test("a path-scoped route emits a PathPrefix rule + stripprefix middleware", () => {
  const doc = buildDoc(WEB_API_COMPOSE, {
    domainRoutes: [
      {
        name: "app.1.2.3.4.nip.io",
        service: "api",
        port: 8080,
        pathPrefix: "/api",
        stripPrefix: true,
      },
    ],
  });
  const api = labelsOf(doc.services.api);
  assert.ok(api.some((l) => l.includes("PathPrefix(`/api`)")));
  assert.ok(api.some((l) => l.includes(".stripprefix.prefixes=/api")));
});

test("a route with no port of its own uses the port the service exposes", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: acme/web
    expose:
      - "8080"
`,
    { domainRoutes: [route("demo.1.2.3.4.nip.io", "web", null)] },
  );
  assert.ok(
    labelsOf(doc.services.web).some((l) =>
      l.endsWith("loadbalancer.server.port=8080"),
    ),
    "expected the exposed port, not the conventional 80",
  );
});

test("buildComposeStack: a route with no certificate lands on the web entrypoint", () => {
  const yaml = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-app",
    deployKey: "app",
    appId: "prj_1",
    filesDir: "/data/stacks/files/app",
    domainRoutes: [
      {
        name: "app-quiet-heron-0a000001.nip.io",
        service: "web",
        port: 80,
        entrypoint: "web",
        tls: false,
        certResolver: "",
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.match(yaml, /entrypoints=web\b/);
  assert.equal(/entrypoints=websecure/.test(yaml), false, yaml);
  assert.equal(/tls=true/.test(yaml), false, yaml);
  assert.equal(/certresolver/.test(yaml), false, yaml);
});

test("buildComposeStack: a route that asked for a certificate still gets one", () => {
  const yaml = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-app",
    deployKey: "app",
    appId: "prj_1",
    filesDir: "/data/stacks/files/app",
    domainRoutes: [
      {
        name: "app.acme.com",
        service: "web",
        port: 80,
        entrypoint: "websecure",
        tls: true,
        certResolver: "letsencrypt",
        pathPrefix: "",
        stripPrefix: false,
      },
    ],
  });
  assert.match(yaml, /entrypoints=websecure/);
  assert.match(yaml, /tls=true/);
  assert.match(yaml, /tls\.certresolver=letsencrypt/);
});

test("every service starts out invisible to Traefik; only a routed one is switched on", () => {
  const doc = buildDoc(`
services:
  web:
    image: nginx
  worker:
    image: alpine
    labels:
      - traefik.enable=true
      - traefik.http.routers.evil.rule=Host(\`victim.com\`)
`);
  assert.ok(labelsOf(doc.services.web).includes("traefik.enable=true"));
  const worker = labelsOf(doc.services.worker);
  assert.ok(worker.includes("traefik.enable=false"), worker.join(" "));
  assert.ok(!worker.some((l) => l.includes("victim.com")), worker.join(" "));
});
