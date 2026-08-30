// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ComposeDomainPicker } from "./compose-domain-picker";
import type { ComposeRouteCandidate } from "@/lib/deploy/compose-lint";

/**
 * What the wizard offers for a hand-written stack: the front door is decided and
 * shown as such, a database is offered but never pre-selected, and a name the
 * platform answers to cannot be picked at all.
 */

const CANDIDATES: ComposeRouteCandidate[] = [
  {
    name: "store_redis",
    port: 80,
    isDatastore: true,
    isReserved: false,
    isPrimary: false,
  },
  {
    name: "postgres",
    port: 5432,
    isDatastore: true,
    isReserved: true,
    isPrimary: false,
  },
  {
    name: "store_backend",
    port: 3001,
    isDatastore: false,
    isReserved: false,
    isPrimary: false,
  },
  {
    name: "store_client",
    port: 80,
    isDatastore: false,
    isReserved: false,
    isPrimary: true,
  },
];

function render(selected: string[] = []): string {
  return renderToStaticMarkup(
    createElement(ComposeDomainPicker, {
      candidates: CANDIDATES,
      selected,
      onToggle: () => {},
    }),
  );
}

/** The checkbox tag for one service row. `disabled` is read as the ATTRIBUTE:
 *  the class list carries `disabled:cursor-not-allowed` on every box. */
function boxOf(html: string, service: string): string {
  const i = html.indexOf(`id="route-${service}"`);
  assert.notEqual(i, -1, `no row for ${service}`);
  return html.slice(html.lastIndexOf("<button", i), html.indexOf(">", i) + 1);
}
const isDisabled = (box: string): boolean => box.includes('disabled=""');

test("every service in the stack is listed, with the port it answers on", () => {
  const html = render();
  for (const c of CANDIDATES) assert.ok(html.includes(c.name), c.name);
  assert.ok(html.includes("port 3001"));
});

test("the primary is ticked and cannot be unticked", () => {
  const box = boxOf(render(), "store_client");
  assert.match(box, /aria-checked="true"/);
  assert.ok(isDisabled(box));
});

test("a database is offered but starts unticked", () => {
  const box = boxOf(render(), "store_redis");
  assert.match(box, /aria-checked="false"/);
  assert.ok(!isDisabled(box), "a database is a choice, not a refusal");
  assert.ok(render().includes("Database"));
});

test("a name the platform answers to cannot be picked", () => {
  const box = boxOf(render(), "postgres");
  assert.ok(isDisabled(box));
  assert.ok(render().includes("Reserved name"));
});

test("a service the user picked comes back ticked", () => {
  const box = boxOf(render(["store_backend"]), "store_backend");
  assert.match(box, /aria-checked="true"/);
});
