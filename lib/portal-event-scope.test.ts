import test from "node:test";
import assert from "node:assert/strict";
import type * as React from "react";
import { scopeListenersToSubtree } from "./portal-event-scope";

/** A card wrapper element that contains `inside`, and nothing else. */
function wrapper(inside: object) {
  const node: { contains(n: unknown): boolean } = {
    contains: (n: unknown) => n === node || n === inside,
  };
  return node;
}

/** The two Nodes a React event exposes, and nothing we don't read. */
const event = (currentTarget: unknown, target: unknown) =>
  ({ currentTarget, target }) as unknown as React.SyntheticEvent;

type Listener = (event: React.SyntheticEvent) => void;

test("runs a listener for a press that started inside the element", () => {
  const inside = {};
  const card = wrapper(inside);
  const seen: string[] = [];
  const scoped = scopeListenersToSubtree({
    onMouseDown: (() => seen.push("mousedown")) as Listener,
  });
  scoped.onMouseDown(event(card, inside));
  assert.deepEqual(seen, ["mousedown"]);
});

test("drops a press that only reached the element through the React tree", () => {
  const portalled = {}; // a Dialog overlay, mounted under <body>
  const card = wrapper({});
  const seen: string[] = [];
  const scoped = scopeListenersToSubtree({
    onMouseDown: (() => seen.push("mousedown")) as Listener,
  });
  scoped.onMouseDown(event(card, portalled));
  assert.deepEqual(seen, []);
});

test("treats the element itself as inside", () => {
  const card = wrapper({});
  let ran = false;
  const scoped = scopeListenersToSubtree({
    onMouseDown: (() => {
      ran = true;
    }) as Listener,
  });
  scoped.onMouseDown(event(card, card));
  assert.equal(ran, true);
});

test("runs the listener when there is no currentTarget to scope to", () => {
  let ran = false;
  const scoped = scopeListenersToSubtree({
    onMouseDown: (() => {
      ran = true;
    }) as Listener,
  });
  scoped.onMouseDown(event(null, {}));
  assert.equal(ran, true);
});

test("wraps every listener and passes non-functions through", () => {
  const inside = {};
  const card = wrapper(inside);
  const seen: string[] = [];
  const scoped = scopeListenersToSubtree({
    onMouseDown: (() => seen.push("mousedown")) as Listener,
    onTouchStart: (() => seen.push("touchstart")) as Listener,
    role: "button",
  });
  assert.equal(scoped.role, "button");
  scoped.onMouseDown(event(card, {}));
  scoped.onTouchStart(event(card, {}));
  assert.deepEqual(
    seen,
    [],
    "both are scoped, so a portalled press runs neither",
  );
  scoped.onMouseDown(event(card, inside));
  scoped.onTouchStart(event(card, inside));
  assert.deepEqual(seen, ["mousedown", "touchstart"]);
});

test("does not mutate the listener map it was given", () => {
  const original = { onMouseDown: (() => {}) as Listener };
  const scoped = scopeListenersToSubtree(original);
  assert.notEqual(scoped.onMouseDown, original.onMouseDown);
});
