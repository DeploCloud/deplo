import test from "node:test";
import assert from "node:assert/strict";

import { comesAlong, serversHref } from "./cluster-join";
import { filterServers, type ServerFilterFields } from "./servers-toolbar";

const acme = { slug: "acme", name: "Acme" };
const labs = { slug: "labs", name: "Labs" };
type Item = ServerFilterFields & { id: string };
const item = (id: string, over: Partial<Item>): Item => ({
  id,
  search: id,
  use: "everything",
  teams: [],
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

test("what joins a cluster with a server is counted in the user's words", () => {
  assert.equal(comesAlong(0, 0), "");
  assert.equal(comesAlong(1, 0), "1 App");
  assert.equal(comesAlong(0, 2), "2 databases");
  assert.equal(comesAlong(3, 1), "3 Apps and 1 database");
});

test("an open cluster and the list view are part of the address", () => {
  assert.equal(serversHref(), "/settings/servers");
  assert.equal(
    serversHref({ cluster: "clu_1" }),
    "/settings/servers?cluster=clu_1",
  );
  assert.equal(
    serversHref({ cluster: "clu_1", view: "list" }),
    "/settings/servers?cluster=clu_1&view=list",
  );
});
