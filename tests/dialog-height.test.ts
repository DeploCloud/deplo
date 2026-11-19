import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// A plain DialogContent animates its height itself; a selfManaged one has to say how it does.
const ANIMATES = /\b(AnimatedHeight|SlidingPanels)\b/;
const OWN_HEIGHT: Record<string, string> = {
  "components/settings/notifications-panel.tsx": "fixed height",
  "components/settings/migrations/migration-console.tsx": "fixed height",
  "components/command-palette/command-palette/palette-dialog.tsx":
    "its list animates its own height",
  "components/env/shared-var-wizard/dialog.tsx": "the wizard body animates",
};

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const selfManaged = [...walk("app"), ...walk("components")].filter(
  (f) =>
    f !== join("components", "ui", "dialog.tsx") &&
    /\bselfManaged\b/.test(readFileSync(f, "utf8")),
);

test("every self-managed dialog grows smoothly or has a height of its own", () => {
  const jumpy = selfManaged.filter(
    (f) =>
      !ANIMATES.test(readFileSync(f, "utf8")) &&
      !(f.replaceAll("\\", "/") in OWN_HEIGHT),
  );
  assert.deepEqual(
    jumpy,
    [],
    "Wrap the part that changes in <AnimatedHeight>, or list the file in OWN_HEIGHT with the reason.",
  );
});

test("OWN_HEIGHT names only self-managed dialogs that still exist", () => {
  for (const f of Object.keys(OWN_HEIGHT)) {
    assert.ok(existsSync(f), `${f} is gone`);
    assert.ok(selfManaged.includes(f), `${f} is no longer selfManaged`);
  }
});
