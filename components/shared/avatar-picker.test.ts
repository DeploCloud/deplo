import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { PathnameContext } from "next/dist/shared/lib/hooks-client-context.shared-runtime";

import { AvatarPicker } from "./avatar-picker";

const render = (children?: string) =>
  renderToStaticMarkup(
    createElement(
      AppRouterContext.Provider,
      { value: {} as never },
      createElement(
        PathnameContext.Provider,
        { value: "/acme/settings" },
        createElement(
          AvatarPicker,
          {
            preview: createElement("span", null, "AC"),
            onSave: async () => ({ ok: true }),
          },
          children,
        ),
      ),
    ),
  );
const rootClass = (html: string) => html.match(/^<div class="([^"]*)"/)?.[1];

// The loading state draws a centred circle, so the picture must be centred too.
test("a picture alone takes no gap for an empty second column", () => {
  assert.doesNotMatch(rootClass(render()) ?? "", /gap-x|grid-cols/);
  assert.match(
    rootClass(render("Ada")) ?? "",
    /grid-cols-\[auto_1fr\] gap-x-4/,
  );
});
