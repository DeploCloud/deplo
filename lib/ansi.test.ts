import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAnsi, stripAnsi } from "./ansi";

/** Flatten segments back to plain text — what the user reads on screen. */
function visible(segments: ReturnType<typeof parseAnsi>): string {
  return segments.map((s) => s.text).join("");
}

test("plain text passes through as one unstyled segment", () => {
  const segs = parseAnsi("#1 transferring dockerfile: 1.14kB done");
  assert.deepEqual(segs, [
    { text: "#1 transferring dockerfile: 1.14kB done", className: "" },
  ]);
});

test("docker's warning line: ESC[33m colors the run, no escape bytes leak", () => {
  // The exact shape a `docker build` emits for its warnings summary.
  const segs = parseAnsi(" \x1b[33m1 warning found (use docker --debug to expand):");
  assert.deepEqual(segs, [
    { text: " ", className: "" },
    {
      text: "1 warning found (use docker --debug to expand):",
      className: "text-yellow-400",
    },
  ]);
  assert.ok(!visible(segs).includes("\x1b"));
});

test("a line starting with a reset renders plain, reset consumed", () => {
  // The continuation line of the same docker warning block.
  const segs = parseAnsi(
    "\x1b[0m - UndefinedVar: Usage of undefined variable '$NIXPACKS_PATH' (line 18)",
  );
  assert.deepEqual(segs, [
    {
      text: " - UndefinedVar: Usage of undefined variable '$NIXPACKS_PATH' (line 18)",
      className: "",
    },
  ]);
});

test("mid-line color changes split into styled runs", () => {
  const segs = parseAnsi("ok \x1b[32mpassed\x1b[0m and \x1b[31mfailed\x1b[0m.");
  assert.deepEqual(segs, [
    { text: "ok ", className: "" },
    { text: "passed", className: "text-green-400" },
    { text: " and ", className: "" },
    { text: "failed", className: "text-red-400" },
    { text: ".", className: "" },
  ]);
});

test("bold and dim combine with color; SGR 22 clears them", () => {
  const segs = parseAnsi("\x1b[1;33mwarn\x1b[22m rest");
  assert.deepEqual(segs, [
    { text: "warn", className: "text-yellow-400 font-semibold" },
    { text: " rest", className: "text-yellow-400" },
  ]);
});

test("256-color and truecolor params are consumed, not rendered as text", () => {
  const segs = parseAnsi("\x1b[38;5;208morange\x1b[0m \x1b[38;2;10;20;30mrgb");
  assert.equal(visible(segs), "orange rgb");
  assert.equal(segs[0].className, "text-zinc-200");
});

test("non-SGR CSI (cursor/clear) and OSC (title) are swallowed", () => {
  const segs = parseAnsi("\x1b[2K\rprogress 42%\x1b]0;title\x07 done");
  assert.equal(visible(segs), "progress 42% done");
});

test("a line that is only escapes yields no segments", () => {
  assert.deepEqual(parseAnsi("\x1b[0m"), []);
});

test("stripAnsi removes escapes and stray controls, keeps \\n and \\t", () => {
  assert.equal(
    stripAnsi(" \x1b[33m1 warning\x1b[0m\n\tindented\r"),
    " 1 warning\n\tindented",
  );
});
