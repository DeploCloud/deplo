import { test } from "node:test";
import assert from "node:assert/strict";

import { breakingBump, epssLabel, fixLine } from "./fix-line";

const base = {
  ecosystem: "npm",
  packageName: "minimist",
  installedVersion: "1.2.5",
  fixedVersion: "1.2.6",
  newerTag: null,
  flaws: 1,
  via: [] as string[],
  direct: true as boolean | null,
};

test("fixLine: one plain line per way of getting the fix", () => {
  assert.equal(
    fixLine({ ...base, fix: "code" }),
    "Update minimist to 1.2.6 in your code",
  );
  assert.equal(
    fixLine({ ...base, fix: "update", flaws: 3 }),
    "A newer build of this image fixes 3 known flaws: update to get it",
  );
  assert.equal(
    fixLine({ ...base, fix: "newer_tag", newerTag: "1.60.2" }),
    "Version 1.60.2 is available and fixes 1 known flaw",
  );
  assert.equal(
    fixLine({ ...base, fix: "upstream", flaws: 2 }),
    "The newer build still has them: waiting on the image's maintainers",
  );
  assert.equal(
    fixLine({ ...base, fix: "unverified" }),
    "A newer build is out: Deplo is checking whether it fixes 1 known flaw",
  );
  assert.equal(
    fixLine({
      ...base,
      packageName: "dompurify",
      installedVersion: "3.4.15",
      fixedVersion: "3.4.17",
      fix: "code",
      via: ["monaco-editor", "@payloadcms/ui"],
      direct: false,
    }),
    "Pulled in by monaco-editor ← @payloadcms/ui: add an override for dompurify 3.4.17",
  );
  assert.equal(
    fixLine({ ...base, fix: "build_only" }),
    "Only used to build the app: it never runs",
  );
  assert.equal(fixLine({ ...base, fix: "deplo" }), "", "never shown");
});

test("epssLabel: a percentage, and <1% rather than a misleading 0%", () => {
  assert.equal(epssLabel(0.1234), "EPSS 12%");
  assert.equal(epssLabel(0.004), "EPSS <1%");
  assert.equal(epssLabel(null), null);
});

test("fixLine: a package the app does not name is never 'in your code'", () => {
  const dompurify = {
    ...base,
    fix: "code" as const,
    packageName: "dompurify",
    installedVersion: "3.4.15",
    fixedVersion: "3.4.17",
  };
  assert.equal(
    fixLine({ ...dompurify, direct: false }),
    "Pulled in by another package: add an override for dompurify 3.4.17",
  );
  assert.equal(
    fixLine({ ...dompurify, direct: null }),
    "Update dompurify to 3.4.17, or add an override if another package pulls it in",
    "an older server agent cannot tell",
  );
  assert.equal(
    fixLine({ ...dompurify, ecosystem: "PyPI", direct: null }),
    "Update dompurify to 3.4.17 in your code",
  );
});

test("fixLine: a new major version is fixed from the package the app names", () => {
  const happyDom = {
    ...base,
    fix: "code" as const,
    packageName: "happy-dom",
    installedVersion: "20.14.6",
    fixedVersion: "21.0.4",
    direct: false,
  };
  assert.equal(
    fixLine({
      ...happyDom,
      via: ["@lexical/headless", "@payloadcms/richtext-lexical"],
    }),
    "Update @payloadcms/richtext-lexical: the fix for happy-dom is a new major version, which an override could break",
  );
  assert.equal(
    fixLine(happyDom),
    "Pulled in by another package: the fix for happy-dom is a new major version, so update the package that pulls it in",
  );
  assert.equal(
    fixLine({ ...happyDom, direct: true }),
    "Update happy-dom to 21.0.4 in your code",
  );
});

test("breakingBump: a major, or a minor on 0.x", () => {
  assert.equal(breakingBump("20.14.6", "21.0.4"), true);
  assert.equal(breakingBump("3.4.15", "3.4.17"), false);
  assert.equal(breakingBump("v0.45.0", "0.52.0"), true);
  assert.equal(breakingBump("0.4.1", "0.4.3"), false);
  assert.equal(breakingBump("1.0.0", null), false);
  assert.equal(breakingBump("abc", "2.0.0"), false);
});
