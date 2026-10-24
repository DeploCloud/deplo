import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FrameworkIcon } from "@/components/shared/framework-icons";
import { FRAMEWORKS } from "@/lib/apps/framework-catalog";

test("every framework in the catalog has a logo, and every logo file ships", () => {
  for (const { id } of FRAMEWORKS) {
    const html = renderToStaticMarkup(createElement(FrameworkIcon, { id }));
    assert.notEqual(html, "", `${id} renders no logo`);
    for (const [, src] of html.matchAll(/src="([^"]+)"/g))
      assert.ok(existsSync(`public${src}`), `${id}: public${src} is missing`);
  }
});
