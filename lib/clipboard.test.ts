import test from "node:test";
import assert from "node:assert/strict";

import { copyText } from "./clipboard";

type El = {
  tag: string;
  value?: string;
  style: Record<string, string>;
  children: El[];
  parentElement: El | null;
  setAttribute(): void;
  remove(): void;
  appendChild(c: El): void;
  focus(): void;
  select(): void;
};

/** A page whose dialog traps focus the way Radix does: whatever is focused
 *  outside the dialog is pulled straight back in. `hostile` traps its own
 *  children too, so nothing can hold the selection. */
function fakeDom({ hostile = false } = {}) {
  const copied: string[] = [];
  const el = (tag: string): El => {
    const e: El = {
      tag,
      style: {},
      children: [],
      parentElement: null,
      setAttribute() {},
      remove() {
        e.parentElement?.children.splice(
          e.parentElement.children.indexOf(e),
          1,
        );
        e.parentElement = null;
      },
      appendChild(c) {
        c.parentElement = e;
        e.children.push(c);
      },
      focus: () => take(e),
      select: () => take(e),
    };
    return e;
  };
  const inDialog = (n: El | null): boolean =>
    !!n && (n === dialog || inDialog(n.parentElement));
  const take = (n: El) => {
    doc.activeElement = hostile || !inDialog(n) ? button : n;
  };

  const body = el("body");
  const dialog = el("div");
  const button = el("button");
  body.appendChild(dialog);
  dialog.appendChild(button);

  const doc = {
    body,
    activeElement: button as El,
    createElement: (tag: string) => el(tag),
    execCommand: (cmd: string) => {
      // A browser answers true even when the selection is gone.
      if (cmd === "copy")
        copied.push(
          doc.activeElement.tag === "textarea"
            ? String(doc.activeElement.value)
            : "",
        );
      return true;
    },
  };
  globalThis.document = doc as never;
  Object.defineProperty(globalThis, "navigator", {
    value: {},
    configurable: true,
  });
  return copied;
}

test("copies from inside a focus-trapped dialog", async () => {
  const copied = fakeDom();
  assert.equal(await copyText("dokploy"), true);
  assert.deepEqual(copied, ["dokploy"]);
});

test("reports failure instead of claiming a copy it lost", async () => {
  const copied = fakeDom({ hostile: true });
  assert.equal(await copyText("dokploy"), false);
  assert.deepEqual(copied, []);
});
