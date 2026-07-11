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
  devEligible: false,
  showFiles: false,
  slugMatches: false,
};

/** A small team: folder Alpha > folder Beta, services at each level + a project. */
function graph(): BreadcrumbGraph {
  return {
    folders: [
      { id: "A", name: "Alpha", parentId: null },
      { id: "B", name: "Beta", parentId: "A" },
    ],
    services: [
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

// Helpers: a service route, and an Overview drill-in.
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

test("non-services-tree path returns null (fallback label)", () => {
  assert.equal(svc("/deployments"), null);
  assert.equal(svc("/storage"), null);
  assert.equal(svc("/settings/registries"), null);
});

test("unknown service slug / unknown folder returns null", () => {
  assert.equal(svc("/services/ghost"), null);
  assert.equal(overview("nope"), null);
});

test("every trail is rooted at an Overview crumb", () => {
  assert.equal(svc("/services/web")![0].kind, "overview");
  assert.equal(overview("B")![0].kind, "overview");
  assert.equal(overview()![0].name, "Overview");
});

/* ---- Service routes -------------------------------------------------- */

test("nested folder service: Overview → folder → folder → service", () => {
  const segs = svc("/services/web")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["folder", "Alpha"],
    ["folder", "Beta"],
    ["service", "Web"],
  ]);
  // Overview dropdown lists the top level; Alpha (the next crumb) is current.
  const ov = segs[0];
  assert.equal(ov.items.find((i) => i.label === "Alpha")!.current, true);
  assert.ok(ov.items.some((i) => i.label === "Store" && i.kind === "project"));
  assert.ok(ov.items.some((i) => i.label === "Loose" && i.kind === "service"));
});

test("folder crumbs mark the next node current and list children", () => {
  const segs = svc("/services/web")!;
  const alpha = segs[1];
  // Alpha offers subfolder Beta (current — the next crumb) + its own service Root.
  assert.deepEqual(
    alpha.items.map((i) => [i.kind, i.label, i.current]),
    [
      ["folder", "Beta", true],
      ["service", "Root", false],
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

test("service crumb lists sibling services in the same folder", () => {
  const segs = svc("/services/web")!;
  const service = segs.find((s) => s.kind === "service")!;
  assert.deepEqual(service.items.map((i) => i.label), ["Api", "Web"]);
  assert.equal(service.items.find((i) => i.label === "Web")!.current, true);
});

test("ungrouped service: Overview → service; Overview marks it current", () => {
  const segs = svc("/services/loose")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["service", "Loose"],
  ]);
  assert.equal(segs[0].items.find((i) => i.label === "Loose")!.current, true);
  assert.deepEqual(segs[1].items.map((i) => i.label), ["Loose"]);
});

test("project service: Overview → project → service, env-scoped siblings", () => {
  const segs = svc("/services/shop")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["project", "Store"],
    ["service", "Shop"],
  ]);
  assert.equal(segs[0].items.find((i) => i.label === "Store")!.current, true);
  // Shop + Cart share env e1; Stage (e2) is excluded.
  assert.deepEqual(segs[1].items.map((i) => i.label), ["Cart", "Shop"]);
});

test("section crumb appended for a sub-page, current flagged", () => {
  const segs = svc("/services/web/deployments")!;
  const section = last(segs);
  assert.equal(section.kind, "section");
  assert.equal(section.name, "Deployments");
  assert.equal(section.items.find((i) => i.current)!.label, "Deployments");
  assert.equal(section.items.find((i) => i.label === "Overview")!.href, "/services/web");
});

test("service settings: Settings crumb + subsection crumb", () => {
  const segs = svc("/services/web/settings/deployments")!;
  assert.deepEqual(shape(segs).slice(-2), [
    ["section", "Settings"],
    ["section", "Deployments"],
  ]);
  const sub = last(segs);
  assert.equal(sub.items.find((i) => i.current)!.label, "Deployments");
  assert.equal(sub.items.find((i) => i.label === "General")!.href, "/services/web/settings");
});

test("bare /settings shows a General subsection crumb with the subsection menu", () => {
  const segs = svc("/services/web/settings")!;
  assert.deepEqual(shape(segs).slice(-2), [
    ["section", "Settings"],
    ["section", "General"],
  ]);
  const general = last(segs);
  assert.equal(general.items.find((i) => i.current)!.label, "General");
  assert.equal(general.items.find((i) => i.label === "Storage")!.href, "/services/web/settings/storage");
});

test("capability gates hide Environment/Backups/Access", () => {
  const caps: BreadcrumbCaps = { manageEnv: false, manageInfra: false, manageDomains: false };
  const main = svc("/services/web/deployments", graph(), caps)!;
  const labels = last(main).items.map((i) => i.label);
  assert.ok(!labels.includes("Environment") && !labels.includes("Backups"));
  const sub = svc("/services/web/settings/storage", graph(), caps)!;
  assert.ok(!last(sub).items.map((i) => i.label).includes("Access"));
});

test("flag-gated sections hidden until the store confirms; current always shown", () => {
  const onConsole = svc("/services/web/console")!;
  assert.ok(last(onConsole).items.map((i) => i.label).includes("Console"));
  const onLogs = svc("/services/web/logs")!;
  assert.ok(!last(onLogs).items.map((i) => i.label).includes("Console"));
  const live: BreadcrumbFlags = { running: true, devEligible: false, showFiles: false, slugMatches: true };
  const onLogsLive = svc("/services/web/logs", graph(), ALL_CAPS, live)!;
  assert.ok(last(onLogsLive).items.map((i) => i.label).includes("Console"));
});

/* ---- Section preservation on sibling links --------------------------- */

test("sibling links preserve the current section (Vercel-style tab keep)", () => {
  const segs = svc("/services/web/deployments")!;
  const service = segs.find((s) => s.kind === "service")!;
  assert.equal(service.items.find((i) => i.label === "Api")!.href, "/services/api/deployments");
  // The leaf folder's child-service entry preserves it too.
  assert.equal(segs[2].items.find((i) => i.label === "Api")!.href, "/services/api/deployments");
});

test("sibling links preserve a settings subsection but drop deep detail ids", () => {
  const onSub = svc("/services/web/settings/storage")!;
  assert.equal(
    onSub.find((s) => s.kind === "service")!.items.find((i) => i.label === "Api")!.href,
    "/services/api/settings/storage",
  );
  const onDetail = svc("/services/web/deployments/dep_123")!;
  assert.equal(
    onDetail.find((s) => s.kind === "service")!.items.find((i) => i.label === "Api")!.href,
    "/services/api/deployments",
  );
});

test("runtime sections (console/dev/files) are NOT preserved on siblings", () => {
  const segs = svc("/services/web/console")!;
  assert.equal(
    segs.find((s) => s.kind === "service")!.items.find((i) => i.label === "Api")!.href,
    "/services/api",
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
  // No service selected, so Beta's child services are listed but none is current.
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

test("browsing a project: Overview → project, dropdown lists all its services", () => {
  const segs = overview(null, "P")!;
  assert.deepEqual(shape(segs), [
    ["overview", "Overview"],
    ["project", "Store"],
  ]);
  // Browsing (no service selected) lists every service in the project, all envs.
  assert.deepEqual(last(segs).items.map((i) => i.label), ["Cart", "Shop", "Stage"]);
});

test("plain Overview root: a single current Overview crumb with the top level", () => {
  const segs = overview()!;
  assert.deepEqual(shape(segs), [["overview", "Overview"]]);
  const ov = segs[0];
  assert.ok(ov.items.some((i) => i.label === "Alpha" && i.kind === "folder"));
  assert.ok(ov.items.some((i) => i.label === "Store" && i.kind === "project"));
  assert.ok(ov.items.some((i) => i.label === "Loose" && i.kind === "service"));
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
