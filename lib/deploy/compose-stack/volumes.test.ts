import { test } from "node:test";
import assert from "node:assert/strict";

import { buildComposeStack } from "./render";
import {
  buildDoc,
  route,
  topVolumes,
  vol,
  volsOf,
  type Svc,
} from "./stack-test-helpers";

test("`./<x>` sources rewrite to the project's files dir; named/flags preserved", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - ./config.toml:/etc/app/config.toml
      - ./nested/dir:/data:ro
      - appdata:/var/lib/app
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.web as Svc & { volumes?: unknown });
  assert.ok(
    vols.includes("/srv/stacks/files/demo/config.toml:/etc/app/config.toml"),
  );
  assert.ok(vols.includes("/srv/stacks/files/demo/nested/dir:/data:ro"));
  assert.ok(vols.includes("appdata:/var/lib/app"));
});

test("a `..` escape source is NOT rewritten (left for the host-bind gate to block)", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - ../sibling/data:/data
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.web as Svc & { volumes?: unknown });
  assert.ok(vols.includes("../sibling/data:/data"));
});

test("an absolute host source is NOT rewritten", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - /srv/host/data:/data
`,
    { filesDir: "/srv/stacks/files/demo" },
  );
  const vols = volsOf(doc.services.web as Svc & { volumes?: unknown });
  assert.ok(vols.includes("/srv/host/data:/data"));
});

test("a named volume mounts into the stack's DEFAULT service and pins its host name", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    ports:
      - "8080:80"
  db:
    image: postgres
`,
    { volumes: [vol({ name: "uploads", mountPath: "/app/uploads" })] },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "uploads:/app/uploads",
  ]);
  assert.deepEqual(volsOf(doc.services.db as Svc & { volumes?: unknown }), []);
  assert.deepEqual(topVolumes(doc), {
    uploads: { name: "deplo-demo-uploads" },
  });
});

test("a volume with no service named stays where it always landed", () => {
  const doc = buildDoc(
    `
services:
  db:
    image: postgres:17
  web:
    image: nginx
`,
    {
      domainRoutes: [route("demo.1.2.3.4.deplo.site", "web", 80)],
      volumes: [vol({ name: "data", mountPath: "/data" })],
    },
  );
  assert.deepEqual(volsOf(doc.services.db as Svc & { volumes?: unknown }), [
    "data:/data",
  ]);
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), []);
});

test("a volume mounts into the service it names, read-only flag included", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
  db:
    image: postgres
`,
    {
      volumes: [
        vol({
          name: "pgdata",
          service: "db",
          mountPath: "/var/lib/postgresql/data",
        }),
        vol({
          id: "vol_2",
          name: "seed",
          service: "db",
          mountPath: "/seed",
          readOnly: true,
        }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.db as Svc & { volumes?: unknown }), [
    "pgdata:/var/lib/postgresql/data",
    "seed:/seed:ro",
  ]);
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), []);
});

test("the service's OWN mount at that path wins (existing-wins)", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
    volumes:
      - authored:/data
`,
    { volumes: [vol({ name: "data", mountPath: "/data" })] },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "authored:/data",
  ]);
  assert.deepEqual(topVolumes(doc), {});
});

test("app-file and host volumes render as binds, with no top-level entry", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
`,
    {
      filesDir: "/srv/stacks/files/demo",
      volumes: [
        vol({
          id: "vol_1",
          type: "app",
          name: "conf",
          projectPath: "config.toml",
          mountPath: "/etc/app/config.toml",
        }),
        vol({
          id: "vol_2",
          type: "host",
          name: "media",
          hostPath: "/srv/media",
          mountPath: "/media",
        }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "/srv/stacks/files/demo/config.toml:/etc/app/config.toml",
    "/srv/media:/media",
  ]);
  assert.deepEqual(topVolumes(doc), {});
});

test("a host bind's propagation reaches the injected mount line", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
`,
    {
      volumes: [
        vol({
          id: "vol_1",
          type: "host",
          name: "neon",
          hostPath: "/srv/neon",
          mountPath: "/srv/neon",
          propagation: "rslave",
        }),
      ],
    },
  );
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "/srv/neon:/srv/neon:rslave",
  ]);
});

test("a top-level key the compose already uses is not clobbered", () => {
  const doc = buildDoc(
    `
services:
  web:
    image: nginx
volumes:
  data:
    external: true
`,
    { volumes: [vol({ name: "data", mountPath: "/data" })] },
  );
  const top = topVolumes(doc);
  assert.deepEqual(top.data, { external: true });
  assert.deepEqual(top["data-2"], { name: "deplo-demo-data" });
  assert.deepEqual(volsOf(doc.services.web as Svc & { volumes?: unknown }), [
    "data-2:/data",
  ]);
});

test("a volume naming a service the compose lacks is a hard error", () => {
  assert.throws(
    () =>
      buildDoc(
        `
services:
  web:
    image: nginx
`,
        {
          volumes: [
            vol({ name: "data", service: "worker", mountPath: "/data" }),
          ],
        },
      ),
    /worker/,
  );
});

test("no volumes ⇒ no `volumes:` key anywhere (byte-identical baseline)", () => {
  const base = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.deplo.site", "web", 80)],
  });
  const withEmpty = buildComposeStack({
    network: "deplo-team-team_test",
    compose: "services:\n  web:\n    image: nginx\n",
    name: "deplo-demo",
    deployKey: "demo",
    appId: "p1",
    domainRoutes: [route("demo.1.2.3.4.deplo.site", "web", 80)],
    volumes: [],
  });
  assert.equal(withEmpty, base);
  assert.ok(!base.includes("volumes:"));
});
