import { test } from "node:test";
import assert from "node:assert/strict";

import { rowsFor, NO_ENVIRONMENT } from "./environment-combobox";

const env = (
  id: string,
  name: string,
  projectId: string,
  projectName: string,
  projectColor: string | null = null,
) => ({ id, name, projectId, projectName, projectColor });

test("the tree opens with no environment, then a header per project", () => {
  const rows = rowsFor([
    env("e1", "Production", "p1", "Neonflix"),
    env("e2", "Staging", "p1", "Neonflix"),
    env("e3", "Production", "p2", "Acme"),
  ]);
  assert.deepEqual(
    rows.map((r) => [r.kind, r.key]),
    [
      ["none", NO_ENVIRONMENT],
      ["project", "project:p1"],
      ["env", "e1"],
      ["env", "e2"],
      ["project", "project:p2"],
      ["env", "e3"],
    ],
  );
});

test("a project keeps its branch when only a child matches", () => {
  const [, header] = rowsFor([
    env("e1", "Production", "p1", "Neonflix"),
    env("e2", "Staging", "p1", "Neonflix"),
  ]);
  assert.ok(header.search.includes("staging"));
});

test("searching a project name reaches every environment under it", () => {
  const rows = rowsFor([env("e1", "Production", "p1", "Neonflix")]);
  assert.ok(
    rows.every((r) => r.kind === "none" || r.search.includes("neonflix")),
  );
});

test("two projects sharing a name stay apart", () => {
  const rows = rowsFor([
    env("e1", "Production", "p1", "Web"),
    env("e2", "Production", "p2", "Web"),
  ]);
  assert.equal(rows.filter((r) => r.kind === "project").length, 2);
});

test("a project's colour rides down to its environments", () => {
  const [, header, child] = rowsFor([
    env("e1", "Production", "p1", "Neonflix", "#7c3aed"),
  ]);
  assert.equal(header.kind === "project" && header.color, "#7c3aed");
  assert.equal(child.kind === "env" && child.color, "#7c3aed");
});

test("a project with no colour carries none, it does not invent one", () => {
  const [, header] = rowsFor([env("e1", "Production", "p1", "Neonflix")]);
  assert.equal(header.kind === "project" && header.color, null);
});
