import test from "node:test";
import assert from "node:assert/strict";
import { pickRelated } from "./related";
import type { CatalogTemplate } from "@/templates/types";

/** A catalogue entry trimmed to what `pickRelated` reads. */
function tpl(slug: string, category: string): CatalogTemplate {
  return {
    name: slug,
    slug,
    logo: null,
    variants: [
      {
        slug: "default",
        name: slug,
        category: { slug: category, name: category, icon: "package" },
      },
    ],
  } as unknown as CatalogTemplate;
}

const catalog = [
  tpl("alpha", "monitoring"),
  tpl("bravo", "monitoring"),
  tpl("charlie", "storage"),
  tpl("delta", "storage"),
  tpl("echo", "ai"),
  tpl("foxtrot", "ai"),
  tpl("golf", "ai"),
  tpl("hotel", "ai"),
];

test("a category with enough siblings needs no filler", () => {
  const picks = pickRelated(catalog, "echo", "ai", 3);
  assert.deepEqual(
    picks.map((t) => t.slug),
    ["foxtrot", "golf", "hotel"],
  );
});

test("a thin category is topped up to the minimum", () => {
  const picks = pickRelated(catalog, "alpha", "monitoring");
  assert.equal(picks.length, 6);
  assert.equal(picks[0].slug, "bravo");
  assert.ok(!picks.some((t) => t.slug === "alpha"), "never itself");
  assert.equal(new Set(picks.map((t) => t.slug)).size, 6, "no duplicates");
});

test("a category of one still fills the row", () => {
  const picks = pickRelated([tpl("solo", "odd"), ...catalog], "solo", "odd");
  assert.equal(picks.length, 6);
});

test("the fillers are the same on every render", () => {
  const a = pickRelated(catalog, "alpha", "monitoring");
  const b = pickRelated(catalog, "alpha", "monitoring");
  assert.deepEqual(
    a.map((t) => t.slug),
    b.map((t) => t.slug),
  );
});

test("two templates do not get the same fillers", () => {
  const a = pickRelated(catalog, "alpha", "monitoring").map((t) => t.slug);
  const b = pickRelated(catalog, "charlie", "storage").map((t) => t.slug);
  assert.notDeepEqual(a.slice(1), b.slice(1));
});

test("a catalogue smaller than the minimum gives what it has", () => {
  const small = [tpl("one", "x"), tpl("two", "y")];
  assert.equal(pickRelated(small, "one", "x").length, 1);
});
