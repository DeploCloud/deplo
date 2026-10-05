import test from "node:test";
import assert from "node:assert/strict";

import { filterServers, type ServerListItem } from "./servers-list";

const acme = { slug: "acme", name: "Acme" };
const labs = { slug: "labs", name: "Labs" };
const item = (id: string, over: Partial<ServerListItem>): ServerListItem => ({
  id,
  search: id,
  use: "everything",
  teams: [],
  card: null,
  row: null,
  ...over,
});
const ITEMS = [
  item("open", { teams: [acme, labs] }),
  item("acme-only", { teams: [acme] }),
  item("builder", { use: "build", teams: [labs] }),
];
const ids = (f: { teams?: string[]; uses?: string[] }) =>
  filterServers(ITEMS, { query: "", teams: [], uses: [], ...f }).map(
    (i) => i.id,
  );

test("a team sees every server it can deploy to, an open one included", () => {
  assert.deepEqual(ids({ teams: ["labs"] }), ["open", "builder"]);
  assert.deepEqual(ids({ teams: ["acme", "labs"] }), [
    "open",
    "acme-only",
    "builder",
  ]);
});

test("the use filter narrows the team one", () => {
  assert.deepEqual(ids({ teams: ["labs"], uses: ["build"] }), ["builder"]);
});
