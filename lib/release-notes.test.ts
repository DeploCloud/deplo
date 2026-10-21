import { test } from "node:test";
import assert from "node:assert/strict";

import { parseReleaseNotes } from "./release-notes";

const C = "https://github.com/DeploCloud/deplo/commit";
const BODY = `## [v0.4.0](https://github.com/DeploCloud/deplo/compare/v0.3.0...v0.4.0) (2026-10-01)


> ⚠️ **If you offer Deplo:** run \`deplo update\`.

### 🚀 Features

* **notify:** alert when an app runs out of memory, by @Snox-dev1 in [#75](https://github.com/DeploCloud/deplo/pull/75) ([f73245fe](${C}/f73245fe7c88))
* **new:** open a compose URL like a template ([f53fe368](${C}/f53fe368f545))

### 🐛 Bug Fixes

* fix without a scope ([5a6ad226](${C}/5a6ad2266))
* a line nobody templated

### 🧪 Experiments

* **lab:** try a thing ([0c1b09cd](${C}/0c1b09cd8d6c))

### 🤝 Contributors

- @Snox-dev1
`;

test("a templated body becomes a note, typed groups and contributors", () => {
  const notes = parseReleaseNotes(BODY);
  assert.ok(notes);
  assert.equal(notes.note, "**If you offer Deplo:** run `deplo update`.");
  assert.deepEqual(
    notes.groups.map((g) => [g.type, g.label, g.items.length]),
    [
      ["feat", "Features", 2],
      ["fix", "Bug Fixes", 2],
      ["other", "Experiments", 1],
    ],
  );
  assert.deepEqual(notes.groups[0]!.items[0], {
    scope: "notify",
    text: "Alert when an app runs out of memory",
    user: "Snox-dev1",
    pr: 75,
    sha: "f73245fe",
  });
  assert.equal(notes.groups[1]!.items[0]!.scope, null);
  assert.deepEqual(notes.groups[1]!.items[1], {
    scope: null,
    text: "a line nobody templated",
    user: null,
    pr: null,
    sha: null,
  });
  assert.deepEqual(notes.contributors, ["Snox-dev1"]);
});

test("a body in another shape is left to the markdown renderer", () => {
  assert.equal(
    parseReleaseNotes("## What's Changed\n* feat: a by @someone"),
    null,
  );
  assert.equal(parseReleaseNotes(""), null);
});
