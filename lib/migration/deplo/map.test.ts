import { test } from "node:test";
import assert from "node:assert/strict";

import { mapDomains, pickPrimaryDomain } from "../map/domains";
import { mapMounts } from "../map/mounts";
import { mapSource } from "../map/app-source";
import { servicesOf } from "../../data/migration-import/source-tree";
import type { SourceApplication, SourceCompose } from "../model";
import { deploExport, exportApp, exportDatabase } from "./deplo-test-helpers";
import type { DeploExportSharedVar } from "./export-shape";
import { appEnv, sourceApplication, sourceDatabase, sourceTree } from "./map";
import { noteText } from "../note";

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

test("apps outside any project stay in their folder, or at the top level", () => {
  const x = deploExport({
    folders: [
      { id: "fld_a", name: "Clients", parentId: null, color: "#112233" },
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
  assert.deepEqual(names, ["Acme", "Clients / Big", "Shop"]);
  const top = tree.find((p) => p.name === "Acme")!;
  assert.deepEqual(
    servicesOf(top.environments![0])
      .map((s) => s.id)
      .sort(),
    ["db_main", "prj_top"],
  );
  assert.deepEqual(top.landing, { kind: "top" });
  assert.deepEqual(tree.find((p) => p.name === "Clients / Big")!.landing, {
    kind: "folder",
    folders: [
      { sourceId: "fld_a", name: "Clients", color: "#112233" },
      { sourceId: "fld_b", name: "Big", color: null },
    ],
  });
  assert.doesNotMatch(
    tree.flatMap((p) => p.platformNotes ?? []).join(" "),
    /came across as a project/,
  );
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
  const vars = new Map(env.envEntries.map((e) => [e.key, e.value]));
  assert.equal(vars.get("ENVV"), "${{environment.ENVV}}");
  assert.equal(vars.get("STRAY"), "inline", "out of scope: its own copy");
  assert.equal(vars.has("UNLINKED"), false);
  assert.ok(env.secretEnvKeys.includes("ENVV"));
});

test("a project with nothing in it still comes across, with its colour and environments", () => {
  const x = deploExport({
    projects: [
      ...deploExport().projects,
      {
        id: "prc_empty",
        name: "Later",
        color: "#ff8800",
        environments: [
          {
            id: "environ_live",
            name: "Live",
            isDefault: true,
            kind: "production",
            gitBranch: "main",
          },
          {
            id: "environ_qa",
            name: "QA",
            isDefault: false,
            kind: "custom",
            gitBranch: "qa",
          },
        ],
      },
    ],
  });
  const later = sourceTree(x).find((p) => p.projectId === "prc_empty");
  assert.ok(later, "an empty project is offered");
  assert.equal(later.color, "#ff8800");
  assert.deepEqual(
    later.environments!.map((e) => [e.name, e.isDefault, e.kind, e.gitBranch]),
    [
      ["Live", true, "production", "main"],
      ["QA", false, "custom", "qa"],
    ],
  );
});

test("an older Deplo that sends no colour or branches says so once", () => {
  const tree = sourceTree(deploExport());
  const shop = tree.find((p) => p.projectId === "prc_shop")!;
  assert.equal(shop.color, undefined);
  assert.equal(shop.environments![0].kind, undefined);
  const notes = tree.flatMap((p) => p.platformNotes ?? []).join(" ");
  assert.equal(notes.match(/too old to send/g)?.length, 1);
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
  assert.deepEqual(env.envEntries, [{ key: "TEAM", value: "mine" }]);
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
  assert.deepEqual(app.envEntries, [{ key: "BOTH", value: "1" }]);
  assert.deepEqual(app.previewEnvEntries, [{ key: "PREVIEW", value: "2" }]);
  assert.deepEqual(app.secretEnvKeys, ["PREVIEW"]);
});

test("a production-only variable is named so previews do not get it", () => {
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
          { key: "PROD", value: "2", secret: false, targets: ["production"] },
        ],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.deepEqual(app.productionOnlyEnvKeys, ["PROD"]);
});

const PREVIEW = {
  baseDomain: "pr.example.com",
  maxActive: 7,
  ttlDays: 14,
  forkPolicy: "deny",
  serverId: "srv_previews",
  https: true,
  autoDeploy: false,
  port: 8080,
  buildDrafts: true,
  comment: false,
  requiredLabels: "preview\nqa",
};

test("preview settings travel in Deplo's own shape, off or on", () => {
  const x = deploExport({
    apps: [exportApp({ previewEnabled: false, preview: PREVIEW })],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.deepEqual(app.nativePreview, { enabled: false, ...PREVIEW });
});

test("a preview override travels with its type, and wins over a preview-only variable", () => {
  const x = deploExport({
    apps: [
      exportApp({
        env: [
          { key: "API", value: "app", secret: true, targets: ["preview"] },
          { key: "ONLY", value: "1", secret: false, targets: ["preview"] },
        ],
        previewEnv: [
          { key: "API", value: "override", secret: false },
          { key: "TOKEN", value: "t", secret: true },
        ],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.deepEqual(app.previewEnvEntries, [
    { key: "ONLY", value: "1" },
    { key: "API", value: "override" },
    { key: "TOKEN", value: "t" },
  ]);
  assert.deepEqual(app.previewSecretEnvKeys, ["TOKEN"]);
});

test("an older Deplo that hands over only on/off says so", () => {
  const x = deploExport({ apps: [exportApp({ previewEnabled: true })] });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.equal(app.nativePreview, undefined);
  assert.equal(app.isPreviewDeploymentsActive, true);
  assert.ok(
    app.platformNotes?.some((n) =>
      /too old to hand over its preview/.test(noteText(n)),
    ),
  );
});

test("a compose app carries its preview settings too", () => {
  const x = deploExport({
    apps: [
      exportApp({
        source: "compose",
        repo: null,
        compose: "services:\n  web:\n    image: nginx\n",
        previewEnabled: true,
        preview: PREVIEW,
        previewEnv: [{ key: "TOKEN", value: "t", secret: true }],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  assert.deepEqual(app.nativePreview, { enabled: true, ...PREVIEW });
  assert.deepEqual(app.previewEnvEntries, [{ key: "TOKEN", value: "t" }]);
});

test("a read-only volume stays read-only", () => {
  const x = deploExport({
    apps: [
      exportApp({
        volumes: [
          {
            id: "v1",
            type: "named",
            name: "data",
            mountPath: "/data",
            readOnly: true,
          },
          {
            id: "v2",
            type: "host",
            name: "logs",
            hostPath: "/srv/logs",
            mountPath: "/logs",
            readOnly: false,
          },
        ],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  const mapped = mapMounts(app.mounts, { isCompose: false });
  assert.deepEqual(
    mapped.value.volumes.map((v) => [v.mountPath, v.readOnly]),
    [
      ["/data", true],
      ["/logs", false],
    ],
  );
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
  assert.equal(
    app.domains?.find((d) => d.host === "www.shop.example")?.nativeRules
      ?.redirectTo,
    "shop.example",
    "the redirect travels to the import, which lands it once its target has",
  );
  assert.equal(
    pickPrimaryDomain(mapped.value)?.host,
    "shop.example",
    "a minted primary cannot be claimed here, so a real one leads",
  );
});

test("a Deplo too old to send a domain's rules says they arrive with the defaults", () => {
  const route = {
    port: 3000,
    pathPrefix: "",
    stripPrefix: false,
    service: null,
    https: true,
    certProvider: "letsencrypt",
    primary: true,
    redirectTo: null,
    generated: false,
  };
  const notesFor = (over: object) => {
    const x = deploExport({
      apps: [
        exportApp({ domains: [{ host: "shop.example", ...route, ...over }] }),
      ],
    });
    return (
      sourceApplication(x, x.apps[0]) as SourceApplication
    ).platformNotes!.join(" ");
  };
  assert.match(notesFor({}), /too old to hand over its domains' Middlewares/);
  assert.doesNotMatch(
    notesFor({ securityHeaders: true, middlewares: [], corsOrigins: [] }),
    /too old to hand over its domains'/,
  );
});

test("the domain the old Deplo marked primary is the primary here", () => {
  const domain = (host: string, primary: boolean) => ({
    host,
    port: 3000,
    pathPrefix: "",
    stripPrefix: false,
    service: null,
    https: true,
    certProvider: "letsencrypt",
    primary,
    redirectTo: null,
    generated: false,
  });
  const x = deploExport({
    apps: [
      exportApp({
        domains: [
          domain("shop.example", false),
          domain("www.shop.example", true),
        ],
      }),
    ],
  });
  const app = sourceApplication(x, x.apps[0]) as SourceApplication;
  const mapped = mapDomains(app.domains, { isCompose: false });
  assert.equal(pickPrimaryDomain(mapped.value)?.host, "www.shop.example");
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
  assert.match(
    db.platformNotes!.join(" "),
    /too old to hand over the variables and settings of cron job\(s\) vacuum/,
  );
});

test("a database carries every limit in Deplo's own shape", () => {
  const x = deploExport({
    databases: [
      exportDatabase({
        resources: { memoryMb: 256, pidsLimit: 64 } as never,
      }),
    ],
  });
  const db = sourceDatabase(x, x.databases[0]);
  assert.deepEqual(db.nativeResources, { memoryMb: 256, pidsLimit: 64 });
});

test("a source too old to send backup history says its restore points stayed behind", () => {
  const backups = [
    {
      schedule: "0 3 * * *",
      enabled: true,
      retentionCount: 7,
      destination: "b",
    },
  ];
  const old = sourceDatabase(deploExport(), exportDatabase({ backups }));
  assert.equal(old.backupRuns, undefined);
  assert.ok(
    old.platformNotes?.some((n) =>
      /too old to send its backup history/.test(noteText(n)),
    ),
  );
  const fresh = sourceDatabase(
    deploExport(),
    exportDatabase({ backups, backupRuns: [] }),
  );
  assert.deepEqual(fresh.backupRuns, []);
  assert.equal(
    fresh.platformNotes?.some((n) => /backup history/.test(noteText(n))),
    false,
  );
});
