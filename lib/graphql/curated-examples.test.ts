import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSchema, parse, validate } from "graphql";
import { buildApiCatalog } from "./introspect";
import { CURATED_EXAMPLES } from "@/components/api-docs/examples";

/**
 * The playground's curated examples are hand-written, so one can drift out of
 * sync with the schema (e.g. a field that returns an object but is written
 * without a sub-selection — the "rebuildService must have a selection of
 * subfields" bug). This validates every curated operation against the live
 * schema so a broken example fails here, not in the user's editor.
 *
 * We rebuild the schema from its SDL (a plain string) with the test's own
 * `graphql` instance, sidestepping the dual-package hazard that arises when a
 * schema object built elsewhere (Pothos bundles its own `graphql`) is passed to
 * a different instance's `validate`.
 */
test("every curated playground example is valid against the schema", () => {
  const { sdl } = buildApiCatalog();
  const schema = buildSchema(sdl);

  for (const ex of CURATED_EXAMPLES) {
    const errors = validate(schema, parse(ex.operation));
    assert.equal(
      errors.length,
      0,
      `Curated example "${ex.label}" is invalid: ${errors[0]?.message}\n${ex.operation}`,
    );
  }
});
