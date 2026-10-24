import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BuildMethodFields,
  RailpackOptions,
} from "@/components/apps/build-method-fields";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { BuildMethodChoice } from "@/lib/apps/build-method";

const noop = () => {};
const render = (el: ReactElement) =>
  renderToStaticMarkup(createElement(TooltipProvider, null, el));

function activeTab(method: BuildMethodChoice) {
  const html = render(
    createElement(BuildMethodFields, {
      method,
      settings: {},
      onMethodChange: noop,
      onSettingsChange: noop,
    }),
  );
  return html.match(
    /data-state="active"[^>]*>(?:<svg.*?<\/svg>)?([^<]+)</,
  )?.[1];
}

test("Railpack has no tab of its own: it shows as Automatic", () => {
  assert.equal(activeTab("auto"), "Automatic");
  assert.equal(activeTab("railpack"), "Automatic");
  assert.equal(activeTab("dockerfile"), "Dockerfile");
  assert.equal(activeTab("compose"), "Compose");
});

test("the Always Railpack box is what tells Railpack from Automatic", () => {
  const checked = (method: BuildMethodChoice) =>
    /id="always-railpack"[^>]*aria-checked="true"|aria-checked="true"[^>]*id="always-railpack"/.test(
      render(
        createElement(RailpackOptions, {
          method,
          settings: {},
          onMethodChange: noop,
          onSettingsChange: noop,
        }),
      ),
    );
  assert.equal(checked("railpack"), true);
  assert.equal(checked("auto"), false);
});

test("Railpack options exist only for the methods that build with it", () => {
  for (const method of ["dockerfile", "compose"] as const) {
    const html = render(
      createElement(RailpackOptions, {
        method,
        settings: {},
        onMethodChange: noop,
        onSettingsChange: noop,
      }),
    );
    assert.equal(html, "");
  }
});
