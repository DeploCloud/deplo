import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALERT_CATEGORIES,
  ALERT_META,
  DEFAULT_ALERTS,
  alertSearchText,
  searchAlerts,
} from "./alerts";
import { ALL_ALERTS, type AlertKey } from "./types";

/**
 * The alert catalog's own invariants. Cheap, and they catch the two mistakes
 * that are otherwise invisible until a user opens the page: a key that exists in
 * the union but appears in no category (so it can never be ticked), and a
 * category listing a key that was renamed away.
 */

test("every alert has a label and a one-line description", () => {
  for (const key of ALL_ALERTS) {
    const meta = ALERT_META[key];
    assert.ok(meta, `${key} has no catalog entry`);
    assert.ok(meta.label.length > 0, `${key} has no label`);
    assert.ok(meta.description.length > 0, `${key} has no description`);
    assert.ok(
      !meta.description.includes("…"),
      `${key}'s description uses an ellipsis`,
    );
    assert.ok(
      !/[–—]/.test(`${meta.label}${meta.description}`),
      `${key} uses an en/em dash`,
    );
  }
});

test("every alert is in exactly one category, and no category invents one", () => {
  const seen = new Map<string, string>();
  for (const cat of ALERT_CATEGORIES)
    for (const key of cat.alerts) {
      assert.ok(
        ALL_ALERTS.includes(key),
        `category ${cat.key} lists ${key}, which is not an alert`,
      );
      const already = seen.get(key);
      assert.equal(already, undefined, `${key} is in ${already} and ${cat.key}`);
      seen.set(key, cat.key);
    }
  for (const key of ALL_ALERTS)
    assert.ok(seen.has(key), `${key} is in no category, so nobody can tick it`);
});

test("the picker's order matches the catalog's order", () => {
  const flat = ALERT_CATEGORIES.flatMap((c) => c.alerts);
  assert.deepEqual(flat, ALL_ALERTS);
});

test("the defaults are a real subset of the catalog", () => {
  for (const key of DEFAULT_ALERTS) assert.ok(ALL_ALERTS.includes(key));
  assert.ok(DEFAULT_ALERTS.length > 0, "a fresh team would hear nothing");
  assert.ok(
    DEFAULT_ALERTS.length < ALL_ALERTS.length,
    "everything on by default is the same as no default",
  );
});

test("search matches on the key, the label and the keywords", () => {
  assert.ok(searchAlerts("deployment failed").includes("deployment_failed"));
  assert.ok(searchAlerts("disk").includes("server_disk_low"));
  // Keyword-only hit: "brute force" is nowhere in the label or description.
  assert.ok(searchAlerts("brute force").includes("failed_logins"));
  assert.deepEqual(searchAlerts("zzzz-no-such-thing"), []);
  assert.deepEqual(searchAlerts(""), ALL_ALERTS);
});

test("search text is underscore-free so a typed key still matches", () => {
  const key: AlertKey = "server_disk_low";
  assert.ok(!alertSearchText(key).includes("_"));
  assert.ok(searchAlerts("server disk").includes(key));
});
