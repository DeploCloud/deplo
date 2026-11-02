import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { bodyDragStarts, dragCloses } from "./use-sheet-drag";

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

describe("mobile sheets", () => {
  test("a short slow drag springs back, a long one or a flick closes", () => {
    assert.equal(dragCloses(40, 400), false);
    assert.equal(dragCloses(80, 900), true);
    assert.equal(dragCloses(30, 30), true);
    assert.equal(dragCloses(15, 5), false);
  });

  test("the body drags only downward, vertically, with nothing scrolled", () => {
    assert.equal(bodyDragStarts(0, 12, false), true);
    assert.equal(
      bodyDragStarts(0, 12, true),
      false,
      "scrolled content scrolls",
    );
    assert.equal(bodyDragStarts(0, -12, false), false, "upward scrolls");
    assert.equal(bodyDragStarts(20, 10, false), false, "sideways is a swipe");
  });

  test("no modal is full screen on a phone", () => {
    const css = readFileSync("app/globals.css", "utf8");
    assert.match(
      css,
      /\[data-slot="sheet"\] \{\s*max-height: calc\(100dvh - var\(--sheet-top-gap\)\) !important;/,
    );
    for (const f of ["components/ui/dialog.tsx", "components/ui/sheet.tsx"])
      assert.match(readFileSync(f, "utf8"), /data-slot="sheet"/, f);
    const fullScreen =
      /max-(sm|md):(inset-0|h-dvh|h-screen|h-full|max-h-none|rounded-none)\b/;
    const offenders = [...walk("components"), ...walk("app")].filter((f) => {
      const src = readFileSync(f, "utf8");
      return /<(Dialog|Sheet)Content\b/.test(src) && fullScreen.test(src);
    });
    assert.deepEqual(offenders, []);
  });

  test("the corner X is for the desktop: below md it is read, not shown", () => {
    for (const f of ["components/ui/dialog.tsx", "components/ui/sheet.tsx"]) {
      const close = readFileSync(f, "utf8").match(
        /<(?:Dialog|Sheet)Primitive\.Close[\s\S]*?className="([^"]+)"/,
      );
      assert.ok(close, f);
      assert.match(close[1], /\bmax-md:sr-only\b/, f);
    }
  });
});
