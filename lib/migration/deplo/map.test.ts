import { test } from "node:test";
import assert from "node:assert/strict";

import { mapDomains } from "../map/domains";
import { mapSource } from "../map/app-source";
import { parseEnvBlob } from "../map/env";
import { servicesOf } from "../../data/migration-import/source-tree";
import type { SourceApplication, SourceCompose } from "../model";
import { deploExport, exportApp, exportDatabase } from "./deplo-test-helpers";
import type { DeploExportSharedVar } from "./export-shape";
import { appEnv, sourceApplication, sourceDatabase, sourceTree } from "./map";

function shared(over: Partial<DeploExportSharedVar>): DeploExportSharedVar {
  return {
    key: "K",
    value: "v",
    secret: false,
    targets: ["production", "preview"],
    teamWide: false,
    autoInject: false,
    projectIds: [],
    environmentIds: [],
    appIds: [],
    ...over,
  };
}

test("an app keeps its project and environment", () => {
  const tree = sourceTree(deploExport());
  const shop = tree.find((p) => p.projectId === "prc_shop");
  assert.ok(shop);
  const prod = shop.environments?.find(
    (e) => e.environmentId === "environ_prod",
  );
  assert.deepEqual(
    servicesOf(prod!).map((s) => [s.kind, s.id]),
    [
      ["application", "prj_web"],
      ["postgres", "db_main"],
    ],
  );
  assert.equal(
    tree.some(
      (p) => p.projectId === "prc_shop" && p.environments?.length === 2,
    ),
    true,
    "an environment with nothing in it is still offered",
  );
});

test("apps outside any project land in a project per folder, and one for the top level", () => {
  const x = deploExport({
    folders: [
      { id: "fld_a", name: "Clients", parentId: null },
      { id: "fld_b", name: "Big", parentId: "fld_a" },
    ],
    apps: [
      exportApp({ id: "prj_top", projectId: null, environmentId: null }),
      exportApp({
        id: "prj_folder",
        projectId: null,
        environmentId: null,
        folderId: "fld_b",
      }),
    ],
    databases: [exportDatabase({ environmentId: null })],
  });
  const tree = sourceTree(x);
  const names = tree.map((p) => p.name).sort();
  assert.deepEqual(names, ["Acme", "Clients / Big"]);
  const top = tree.find((p) => p.name === "Acme")!;
  assert.deepEqual(
    servicesOf(top.environments![0])
      .map((s) => s.id)
      .sort(),
    ["db_main", "prj_top"],
  );
  assert.match(top.platformNotes!.join(" "), /top level on \{panel\}/);
});

test("a linked shared variable becomes a reference at the narrowest level that offers it", () => {
  const x = deploExport({
    sharedVars: [
      shared({ key: "TEAM", teamWide: true, appIds: ["prj_web"] }),
      shared({ key: "PROJ", projectIds: ["prc_shop"], appIds: ["prj_web"] }),
      shared({
        key: "ENVV",
        environmentIds: ["environ_prod"],
        appIds: ["prj_web"],
        secret: true,
      }),
      shared({ key: "UNLINKED", teamWide: true }),
      shared({ key: "AUTO", teamWide: true, autoInject: true }),
      shared({ key: "STRAY", value: "inline", appIds: ["prj_web"] }),
    ],
  });
  const env = appEnv(x, x.apps[0]);
  assert.deepEqual(env.sharedRefs.map((r) => [r.key, r.level]).sort(), [
    ["AUTO", "team"],
    ["ENVV", "environment"],
    ["PROJ", "project"],
    ["TEAM", "team"],
  ]);
  const vars = new Map(parseEnvBlob(env.env).map((e) => [e.key, e.value]));
  assert.equal(vars.get("ENVV"), "${{environment.ENVV}}");
  assert.equal(vars.get("STRAY"), "inline", "out of scope: its own copy");
  assert.equal(vars.has("UNLINKED"), false);
  assert.ok(env.secretEnvKeys.includes("ENVV"));
});

test("an app's own variable wins over a shared one of the same name", () => {
  const x = deploExport({
    apps: [
      exportApp({
        env: [
          {
            key: "TEAM",
            value: "mine",
            secret: false,
            targets: ["production"],
          },
        ],
      }),
    ],
    sharedVars: [shared({ key: "TEAM", teamWide: true, appIds: ["prj_web"] })],
  });
  const env = appEnv(x, x.apps[0]);
  assert.deepEqual(env.sharedRefs, []);
  assert.deepEqual(parseEnvBlob(env.env), [{ key: "TEAM", value: "mine" }]);
});

test("a preview-only variable stays a preview variable", () => {
  const x = deploExport({
    apps: [
      exportApp({
        env: [
          {
            key: "BOTH",
            value: "1",
            secret: false,
            targets: ["production", "preview"],
          },
          { key: "PREVIEW", value: "2", secret: true, targets: ["preview"] },
        ],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.deepEqual(parseEnvBlob(app.env), [{ key: "BOTH", value: "1" }]);
  assert.deepEqual(parseEnvBlob(app.previewEnv), [
    { key: "PREVIEW", value: "2" },
  ]);
  assert.deepEqual(app.secretEnvKeys, ["PREVIEW"]);
});

test("each git provider maps to a repository the importer clones from the same place", () => {
  for (const [provider, url, repo] of [
    ["github", "https://github.com/acme/web.git", "acme/web"],
    ["gitlab", "https://gitlab.acme.io/group/sub/web.git", "group/sub/web"],
    ["gitea", "https://git.acme.io/acme/web.git", "acme/web"],
    ["bitbucket", "https://bitbucket.org/acme/web.git", "acme/web"],
    ["git", "https://code.acme.io/web.git", "web"],
  ] as const) {
    const x = deploExport({
      apps: [
        exportApp({
          repo: { provider, url, repo, branch: "trunk", watchPaths: ["api/"] },
        }),
      ],
    });
    const mapped = mapSource(
      sourceApplication(x, x.apps[0]) as SourceApplication,
    );
    assert.equal(mapped.value.kind, "git", provider);
    if (mapped.value.kind !== "git") continue;
    assert.equal(mapped.value.repo.url, url, provider);
    assert.equal(mapped.value.repo.branch, "trunk", provider);
    assert.deepEqual(mapped.value.repo.watchPaths, ["api/"], provider);
  }
});

test("build settings and resources travel in Deplo's own shape", () => {
  const x = deploExport({
    apps: [
      exportApp({
        resources: { memoryMb: 512, pidsLimit: 100 } as never,
        build: {
          ...exportApp().build,
          buildCache: false,
          runtimeVersion: "22",
        },
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.equal(app.nativeBuild?.buildCache, false);
  assert.equal(app.nativeBuild?.runtimeVersion, "22");
  assert.equal("buildCacheClearPending" in (app.nativeBuild ?? {}), false);
  assert.deepEqual(app.nativeResources, { memoryMb: 512, pidsLimit: 100 });
});

test("a host the old Deplo minted is not claimed as somebody's domain", () => {
  const x = deploExport({
    apps: [
      exportApp({
        domains: [
          {
            host: "web.apps.old.example",
            port: 3000,
            pathPrefix: "",
            stripPrefix: false,
            service: null,
            https: true,
            certProvider: "letsencrypt",
            primary: true,
            redirectTo: null,
            generated: true,
          },
          {
            host: "shop.example",
            port: 3000,
            pathPrefix: "",
            stripPrefix: false,
            service: null,
            https: true,
            certProvider: "letsencrypt",
            primary: false,
            redirectTo: null,
            generated: false,
          },
          {
            host: "www.shop.example",
            port: null,
            pathPrefix: "",
            stripPrefix: false,
            service: null,
            https: true,
            certProvider: "letsencrypt",
            primary: false,
            redirectTo: "shop.example",
            generated: false,
          },
        ],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  const mapped = mapDomains(app.domains, { isCompose: false });
  assert.deepEqual(
    mapped.value.map((d) => [d.host, d.generated]),
    [
      ["web.apps.old.example", true],
      ["shop.example", false],
    ],
  );
  assert.match(
    app.platformNotes!.join(" "),
    /www\.shop\.example only redirected/,
  );
});

test("a compose app carries its stack and its files", () => {
  const x = deploExport({
    apps: [
      exportApp({
        source: "compose",
        repo: null,
        compose: "services:\n  web:\n    image: nginx\n",
        files: [{ filePath: "nginx.conf", content: "server {}" }],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceCompose;
  assert.equal(app.composeId, "prj_web");
  assert.equal(app.sourceType, "raw");
  assert.match(app.composeFile ?? "", /image: nginx/);
  assert.deepEqual(
    app.mounts?.map((m) => [m.type, m.filePath, m.content]),
    [["file", "nginx.conf", "server {}"]],
  );
});

test("a database keeps its engine, version and credentials", () => {
  const x = deploExport({
    databases: [
      exportDatabase({
        type: "mongodb",
        version: "7",
        crons: [
          {
            name: "vacuum",
            schedule: "0 3 * * *",
            command: "x",
            service: null,
            enabled: true,
          },
        ],
      }),
    ],
  });
  const db = sourceDatabase(x, x.databases[0]);
  assert.equal(db.mongoId, "db_main");
  assert.equal(db.dockerImage, "mongo:7");
  assert.equal(db.databasePassword, "pw");
  assert.match(db.platformNotes!.join(" "), /vacuum ran on a schedule/);
});
