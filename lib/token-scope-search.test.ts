import { test } from "node:test";
import assert from "node:assert/strict";

import { filterScopeTree } from "./token-scope-search";
import type { ScopeTreeTeam } from "./data/tokens";

/**
 * The scope search.
 */
const app = (id: string, name = id, slug = id) => ({
  id,
  name,
  slug,
  logo: null,
});

const TREE: ScopeTreeTeam[] = [
  {
    id: "team_a",
    name: "Acme",
    avatarUrl: null,
    projects: [
      {
        id: "prc_mkt",
        name: "Marketing",
        color: null,
        environments: [],
        folders: [
          {
            id: "fld_web",
            name: "Websites",
            color: null,
            folders: [
              {
                id: "fld_land",
                name: "Landing pages",
                color: null,
                folders: [],
                apps: [app("prj_bf", "black-friday")],
              },
            ],
            apps: [app("prj_site", "corporate-site")],
          },
        ],
        apps: [app("prj_api", "marketing-api")],
      },
    ],
    folders: [
      {
        id: "fld_int",
        name: "Internal tools",
        color: null,
        folders: [],
        apps: [app("prj_inv", "invoice-tool")],
      },
    ],
    looseApps: [app("prj_cron", "legacy-cron")],
  },
  {
    id: "team_b",
    name: "Idra Arts",
    avatarUrl: null,
    projects: [],
    folders: [],
    looseApps: [],
  },
];

test("a match three folders deep pulls its whole ancestry through", () => {
  const [team, ...rest] = filterScopeTree(TREE, ["black"]);
  assert.deepEqual(rest, [], "the team with no hit is dropped");
  assert.equal(team!.id, "team_a");
  assert.deepEqual(team!.looseApps, []);
  assert.deepEqual(team!.folders, []);
  const folder = team!.projects[0]!.folders[0]!;
  assert.equal(folder.id, "fld_web");
  assert.deepEqual(folder.apps, [], "the sibling app is filtered out");
  assert.deepEqual(
    folder.folders[0]!.apps.map((a) => a.name),
    ["black-friday"],
  );
});

test("a node that matches itself keeps everything under it", () => {
  const folder = filterScopeTree(TREE, ["websites"])[0]!.projects[0]!
    .folders[0]!;
  assert.equal(folder.id, "fld_web");
  assert.deepEqual(
    folder.apps.map((a) => a.name),
    ["corporate-site"],
  );
  assert.deepEqual(
    folder.folders[0]!.apps.map((a) => a.name),
    ["black-friday"],
  );
});

test("a matching team is returned whole", () => {
  assert.deepEqual(filterScopeTree(TREE, ["acme"]), [TREE[0]]);
});

test("apps match on their slug as well as their name", () => {
  const hit = filterScopeTree(
    [
      {
        ...TREE[0]!,
        looseApps: [app("prj_x", "Nightly job", "cron-runner")],
        projects: [],
        folders: [],
      },
    ],
    ["cron-runner"],
  );
  assert.deepEqual(
    hit[0]!.looseApps.map((a) => a.id),
    ["prj_x"],
  );
});

test("every term must match - the search is an AND", () => {
  assert.deepEqual(filterScopeTree(TREE, ["landing", "pages"]).length, 1);
  assert.deepEqual(filterScopeTree(TREE, ["landing", "nope"]), []);
});

test("no match anywhere yields an empty tree, not the whole one", () => {
  assert.deepEqual(filterScopeTree(TREE, ["zzz"]), []);
});

test("a top-level folder and a loose app are reachable by search", () => {
  assert.deepEqual(
    filterScopeTree(TREE, ["internal"])[0]!.folders.map((f) => f.id),
    ["fld_int"],
  );
  assert.deepEqual(
    filterScopeTree(TREE, ["legacy"])[0]!.looseApps.map((a) => a.id),
    ["prj_cron"],
  );
});
