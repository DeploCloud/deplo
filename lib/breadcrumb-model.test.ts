import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildBreadcrumb,
  folderChainFor,
  type BreadcrumbGraph,
  type BreadcrumbCaps,
  type BreadcrumbFlags,
  type BreadcrumbSegment,
} from "./breadcrumb-model";

const ALL_CAPS: BreadcrumbCaps = {
  manageEnv: true,
  manageInfra: true,
  manageDomains: true,
};
const NO_FLAGS: BreadcrumbFlags = {
  running: false,
  showFiles: false,
  slugMatches: false,
};

/** A small team: folder Alpha > folder Beta, apps at each level + a project. */
function graph(): BreadcrumbGraph {
  return {
    folders: [
      { id: "A", name: "Alpha", parentId: null },
      { id: "B", name: "Beta", parentId: "A" },
    ],
    apps: [
      { id: "s1", slug: "web", name: "Web", folderId: "B", projectId: null, environmentId: null },
      { id: "s2", slug: "api", name: "Api", folderId: "B", projectId: null, environmentId: null },
      { id: "s3", slug: "root", name: "Root", folderId: "A", projectId: null, environmentId: null },
      { id: "s4", slug: "loose", name: "Loose", folderId: null, projectId: null, environmentId: null },
      { id: "s5", slug: "shop", name: "Shop", folderId: null, projectId: "P", environmentId: "e1" },
      { id: "s6", slug: "cart", name: "Cart", folderId: null, projectId: "P", environmentId: "e1" },
      { id: "s7", slug: "stage", name: "Stage", folderId: null, projectId: "P", environmentId: "e2" },
    ],
    projects: [{ id: "P", name: "Store" }],
  };
}

// Helpers: an app route, and an Overview drill-in.
const svc = (
  pathname: string,
  g: BreadcrumbGraph = graph(),
  caps: BreadcrumbCaps = ALL_CAPS,
  flags: BreadcrumbFlags = NO_FLAGS,
) => buildBreadcrumb({ pathname, openFolderId: null, openProjectId: null, view: "grid" }, g, caps, flags);
const overview = (
  openFolderId: string | null = null,
  openProjectId: string | null = null,
  view: "grid" | "list" = "grid",
  g: BreadcrumbGraph = graph(),
) => buildBreadcrumb({ pathname: "/", openFolderId, openProjectId, view }, g, ALL_CAPS, NO_FLAGS);

const shape = (segs: BreadcrumbSegment[]) => segs.map((s) => [s.kind, s.name]);
const last = (segs: BreadcrumbSegment[]) => segs[segs.length - 1];

test("non-apps-tree path returns null (fallback label)", () => {
  assert.equal(svc("/deployments"), null);
  assert.equal(svc("/storage"), null);
  assert.equal(svc("/settings/registries"), null);
});

test("unknown app slug / unknown folder returns null", () => {
  assert.equal(svc("/apps/ghost"), null);
  assert.equal(overview("nope"), null);
});

test("every trail is rooted at an Overview crumb", () => {
  assert.equal(svc("/apps/web")![0].kind, "overview");
  assert.equal(overview("B")![0].kind, "overview");
  assert.equal(overview()![0].name, "Overview");
});

/* ---- App routes -------------------------------------------------- */

test("nested folder app: Overview → folder → folder → app", () => {
  const segs = svc("/apps/web")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["folder", "Alpha"],
    ["folder", "Beta"],
    ["app", "Web"],
  ]);
  // Overview dropdown lists the top level; Alpha (the next crumb) is current.
  const ov = segs[0];
  assert.equal(ov.items.find((i) => i.label === "Alpha")!.current, true);
  assert.ok(ov.items.some((i) => i.label === "Store" && i.kind === "project"));
  assert.ok(ov.items.some((i) => i.label === "Loose" && i.kind === "app"));
});

test("folder crumbs mark the next node current and list children", () => {
  const segs = svc("/apps/web")!;
  const alpha = segs[1];
  // Alpha offers subfolder Beta (current — the next crumb) + its own app Root.
  assert.deepEqual(
    alpha.items.map((i) => [i.kind, i.label, i.current]),
    [
      ["folder", "Beta", true],
      ["app", "Root", false],
    ],
  );
  const beta = segs[2];
  // Beta (leaf) holds Api + Web; Web is current.
  assert.deepEqual(
    beta.items.map((i) => [i.label, i.current]),
    [
      ["Api", false],
      ["Web", true],
    ],
  );
});

test("app crumb lists sibling apps in the same folder", () => {
  const segs = svc("/apps/web")!;
  const service = segs.find((s) => s.kind === "app")!;
  assert.deepEqual(service.items.map((i) => i.label), ["Api", "Web"]);
  assert.equal(service.items.find((i) => i.label === "Web")!.current, true);
});

test("app entries carry the app's logo, wherever they are listed", () => {
  const g = graph();
  g.apps.find((a) => a.slug === "web")!.logo = "https://cdn.test/web.png";
  g.apps.find((a) => a.slug === "shop")!.logo = "https://cdn.test/shop.png";

  // Sibling menu on the app crumb, and the folder crumb that holds it.
  const segs = svc("/apps/api", g)!;
  const siblings = segs.find((s) => s.kind === "app")!.items;
  assert.equal(
    siblings.find((i) => i.label === "Web")!.logo,
    "https://cdn.test/web.png",
  );
  // No logo set ⇒ null, so the renderer falls back to the generic glyph.
  assert.equal(siblings.find((i) => i.label === "Api")!.logo, null);
  assert.equal(
    segs[2].items.find((i) => i.label === "Web")!.logo,
    "https://cdn.test/web.png",
  );

  // Project crumb + the Overview root's ungrouped apps.
  const proj = svc("/apps/shop", g)!.find((s) => s.kind === "project")!;
  assert.equal(
    proj.items.find((i) => i.label === "Shop")!.logo,
    "https://cdn.test/shop.png",
  );
  const root = overview(null, null, "grid", g)![0];
  assert.equal(root.items.find((i) => i.label === "Loose")!.logo, null);
  // Folders and projects have no logo of their own — the field stays absent.
  assert.equal(root.items.find((i) => i.kind === "folder")!.logo, undefined);
  assert.equal(root.items.find((i) => i.kind === "project")!.logo, undefined);
});

test("ungrouped app: Overview → app; Overview marks it current", () => {
  const segs = svc("/apps/loose")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["app", "Loose"],
  ]);
  assert.equal(segs[0].items.find((i) => i.label === "Loose")!.current, true);
  assert.deepEqual(segs[1].items.map((i) => i.label), ["Loose"]);
});

test("project app: Overview → project → app, env-scoped siblings", () => {
  const segs = svc("/apps/shop")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["project", "Store"],
    ["app", "Shop"],
  ]);
  assert.equal(segs[0].items.find((i) => i.label === "Store")!.current, true);
  // Shop + Cart share env e1; Stage (e2) is excluded.
  assert.deepEqual(segs[1].items.map((i) => i.label), ["Cart", "Shop"]);
});

test("section crumb appended for a sub-page, current flagged", () => {
  const segs = svc("/apps/web/deployments")!;
  const section = last(segs);
  assert.equal(section.kind, "section");
  assert.equal(section.name, "Deployments");
  assert.equal(section.items.find((i) => i.current)!.label, "Deployments");
  assert.equal(section.items.find((i) => i.label === "Overview")!.href, "/apps/web");
});

test("app settings: Settings crumb + subsection crumb", () => {
  const segs = svc("/apps/web/settings/deployments")!;
  assert.deepEqual(shape(segs).slice(-2), [
    ["section", "Settings"],
    ["section", "Deployments"],
  ]);
  const sub = last(segs);
  assert.equal(sub.items.find((i) => i.current)!.label, "Deployments");
  assert.equal(sub.items.find((i) => i.label === "General")!.href, "/apps/web/settings");
});

test("bare /settings shows a General subsection crumb with the subsection menu", () => {
  const segs = svc("/apps/web/settings")!;
  assert.deepEqual(shape(segs).slice(-2), [
    ["section", "Settings"],
    ["section", "General"],
  ]);
  const general = last(segs);
  assert.equal(general.items.find((i) => i.current)!.label, "General");
  assert.equal(general.items.find((i) => i.label === "Storage")!.href, "/apps/web/settings/storage");
});

test("capability gates hide Environment/Backups/Access", () => {
  const caps: BreadcrumbCaps = { manageEnv: false, manageInfra: false, manageDomains: false };
  const main = svc("/apps/web/deployments", graph(), caps)!;
  const labels = last(main).items.map((i) => i.label);
  assert.ok(!labels.includes("Environment") && !labels.includes("Backups"));
  const sub = svc("/apps/web/settings/storage", graph(), caps)!;
  assert.ok(!last(sub).items.map((i) => i.label).includes("Access"));
});

test("flag-gated sections hidden until the store confirms; current always shown", () => {
  const onConsole = svc("/apps/web/console")!;
  assert.ok(last(onConsole).items.map((i) => i.label).includes("Console"));
  const onLogs = svc("/apps/web/logs")!;
  assert.ok(!last(onLogs).items.map((i) => i.label).includes("Console"));
  const live: BreadcrumbFlags = { running: true, showFiles: false, slugMatches: true };
  const onLogsLive = svc("/apps/web/logs", graph(), ALL_CAPS, live)!;
  assert.ok(last(onLogsLive).items.map((i) => i.label).includes("Console"));
});

/* ---- Section preservation on sibling links --------------------------- */

test("sibling links preserve the current section (Vercel-style tab keep)", () => {
  const segs = svc("/apps/web/deployments")!;
  const service = segs.find((s) => s.kind === "app")!;
  assert.equal(service.items.find((i) => i.label === "Api")!.href, "/apps/api/deployments");
  // The leaf folder's child-app entry preserves it too.
  assert.equal(segs[2].items.find((i) => i.label === "Api")!.href, "/apps/api/deployments");
});

test("sibling links preserve a settings subsection but drop deep detail ids", () => {
  const onSub = svc("/apps/web/settings/storage")!;
  assert.equal(
    onSub.find((s) => s.kind === "app")!.items.find((i) => i.label === "Api")!.href,
    "/apps/api/settings/storage",
  );
  const onDetail = svc("/apps/web/deployments/dep_123")!;
  assert.equal(
    onDetail.find((s) => s.kind === "app")!.items.find((i) => i.label === "Api")!.href,
    "/apps/api/deployments",
  );
});

test("runtime sections (console/dev/files) are NOT preserved on siblings", () => {
  const segs = svc("/apps/web/console")!;
  assert.equal(
    segs.find((s) => s.kind === "app")!.items.find((i) => i.label === "Api")!.href,
    "/apps/api",
  );
});

/* ---- Overview folder / project browsing ------------------------------ */

test("browsing a subfolder: Overview → Alpha → Beta (leaf is current page)", () => {
  const segs = overview("B")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["folder", "Alpha"],
    ["folder", "Beta"],
  ]);
  // No app selected, so Beta's child apps are listed but none is current.
  const beta = last(segs);
  assert.deepEqual(beta.items.map((i) => [i.label, i.current]), [
    ["Api", false],
    ["Web", false],
  ]);
  // Overview marks Alpha (the next crumb) current; Alpha marks Beta current.
  assert.equal(segs[0].items.find((i) => i.label === "Alpha")!.current, true);
  assert.equal(segs[1].items.find((i) => i.label === "Beta")!.current, true);
});

test("browsing a top-level folder: Overview → Alpha", () => {
  const segs = overview("A")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["folder", "Alpha"],
  ]);
});

test("browsing a project: Overview → project, dropdown lists all its apps", () => {
  const segs = overview(null, "P")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["project", "Store"],
  ]);
  // Browsing (no app selected) lists every app in the project, all envs.
  assert.deepEqual(last(segs).items.map((i) => i.label), ["Cart", "Shop", "Stage"]);
});

test("plain Overview root: a single current Overview crumb with the top level", () => {
  const segs = overview()!;
  assert.deepEqual(shape(segs), [["overview", "Overview"]]);
  const ov = segs[0];
  assert.ok(ov.items.some((i) => i.label === "Alpha" && i.kind === "folder"));
  assert.ok(ov.items.some((i) => i.label === "Store" && i.kind === "project"));
  assert.ok(ov.items.some((i) => i.label === "Loose" && i.kind === "app"));
  assert.ok(ov.items.every((i) => !i.current)); // nothing deeper is selected
});

test("list view is preserved in folder / project / overview links", () => {
  const segs = overview("B", null, "list")!;
  assert.equal(segs[0].href, "/?view=list");
  assert.equal(segs[1].href, "/?folder=A&view=list");
  assert.equal(segs[2].href, "/?folder=B&view=list");
  const proj = overview(null, "P", "list")!;
  assert.equal(proj[1].href, "/?project=P&view=list");
});

/* ---- folderChainFor edge cases --------------------------------------- */

test("folderChainFor tolerates a broken parent link and a cycle", () => {
  const dangling = folderChainFor("B", [{ id: "B", name: "B", parentId: "A" }]);
  assert.deepEqual(dangling.map((f) => f.id), ["B"]);
  const cyclic = folderChainFor("B", [
    { id: "A", name: "A", parentId: "B" },
    { id: "B", name: "B", parentId: "A" },
  ]);
  assert.equal(cyclic.length, 2);
});
