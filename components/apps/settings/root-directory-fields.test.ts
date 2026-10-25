import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { RootDirectoryFields } from "@/components/apps/settings/root-directory-fields";
import { TooltipProvider } from "@/components/ui/tooltip";
import { buildConfigFor } from "@/lib/frameworks";

test("the root directory is a row: its label on the left, the input on the right", () => {
  const html = renderToStaticMarkup(
    createElement(
      TooltipProvider,
      null,
      createElement(RootDirectoryFields, {
        build: { ...buildConfigFor({}), rootDirectory: "apps/web" },
        onBuildChange: () => {},
      }),
    ),
  );
  const root = html.match(/^<div class="([^"]+)"/)?.[1] ?? "";
  assert.match(root, /sm:flex-row/);
  assert.match(root, /sm:justify-between/);
  const label = html.indexOf('for="root-directory"');
  const input = html.indexOf('id="root-directory"');
  assert.ok(label !== -1 && input > label, "the label comes first");
  assert.match(html, /class="[^"]*sm:w-56[^"]*"><svg/);
  assert.match(html, /value="apps\/web"/);
});
