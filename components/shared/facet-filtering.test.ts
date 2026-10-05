import test from "node:test";
import assert from "node:assert/strict";

import { countBy, inAny, teamFacetOptions } from "./facet-filtering";

const acme = { slug: "acme", name: "Acme" };
const labs = { slug: "labs", name: "Labs" };

test("a team is offered once, sorted by name, counted by rows", () => {
  const { options, counts } = teamFacetOptions([
    [labs],
    [acme, labs],
    [acme, acme],
    [],
  ]);
  assert.deepEqual(options, [
    { value: "acme", label: "Acme" },
    { value: "labs", label: "Labs" },
  ]);
  assert.deepEqual(counts, { acme: 2, labs: 2 });
});

test("nothing picked keeps every row, otherwise any match does", () => {
  assert.equal(inAny([], []), true);
  assert.equal(inAny(["acme"], ["labs", "acme"]), true);
  assert.equal(inAny(["acme"], []), false);
});

test("countBy tallies rows by their key", () => {
  assert.deepEqual(
    countBy(["a", "b", "a"], (x) => x),
    { a: 2, b: 1 },
  );
});
