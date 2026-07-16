import { test } from "node:test";
import assert from "node:assert/strict";
import { Terminal } from "@xterm/headless";
import { LineEditor } from "./exec-line-editor";

// Every test drives the REAL escape sequences through a headless xterm and
// asserts what a user would actually see: screen rows + caret cell. The prompt
// is SGR-coloured like the live console so zero-width sequences are exercised.

const PROMPT = "p$"; // visible width 3 with the trailing space

function makeEditor({ cols = 40, rows = 10 } = {}) {
  const term = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true });
  const submitted: string[] = [];
  const ed = new LineEditor(
    {
      write: (d) => term.write(d),
      cols: () => term.cols,
      reset: () => term.reset(),
    },
    `\x1b[32m${PROMPT}\x1b[0m `,
    PROMPT.length + 1,
    (cmd) => submitted.push(cmd),
  );
  ed.freshPrompt();
  return { term, ed, submitted };
}

/** xterm writes are queued — settle the parser before reading the buffer. */
const flush = (term: Terminal) =>
  new Promise<void>((resolve) => term.write("", resolve));

/** Screen row `y` (absolute buffer row), right-trimmed. */
function row(term: Terminal, y: number): string {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? "";
}

/** Caret cell in absolute buffer coordinates. */
function caret(term: Terminal) {
  const b = term.buffer.active;
  return { x: b.cursorX, y: b.baseY + b.cursorY };
}

function type(ed: LineEditor, keys: string[]) {
  for (const k of keys) ed.data(k);
}

const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";
const HOME = "\x1b[H";
const END = "\x1b[F";
const DEL = "\x1b[3~";
const BS = "\x7f";
const UP = "\x1b[A";
const DOWN = "\x1b[B";

test("typing echoes after the prompt and Enter submits the line", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("ls -la");
  ed.data("\r");
  await flush(term);
  assert.equal(row(term, 0), "p$ ls -la");
  assert.deepEqual(submitted, ["ls -la"]);
  // Output lands on the row below the submitted line.
  assert.deepEqual(caret(term), { x: 0, y: 1 });
});

test("← moves the caret and printable input inserts mid-line", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("hello");
  type(ed, [LEFT, LEFT]);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3 + 3, y: 0 });
  ed.data("XY");
  await flush(term);
  assert.equal(row(term, 0), "p$ helXYlo");
  assert.deepEqual(caret(term), { x: 3 + 5, y: 0 });
  ed.data("\r");
  assert.deepEqual(submitted, ["helXYlo"]);
});

test("→ never walks past the end, ← never into the prompt", async () => {
  const { term, ed } = makeEditor();
  ed.data("ab");
  type(ed, [RIGHT, RIGHT, RIGHT]);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3 + 2, y: 0 });
  type(ed, [LEFT, LEFT, LEFT, LEFT, LEFT]);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3, y: 0 });
});

test("Home/End (and Ctrl-A/Ctrl-E) jump to the line edges", async () => {
  const { term, ed } = makeEditor();
  ed.data("abcdef");
  ed.data(HOME);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3, y: 0 });
  ed.data(END);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3 + 6, y: 0 });
  ed.data("\x01"); // Ctrl-A
  await flush(term);
  assert.deepEqual(caret(term), { x: 3, y: 0 });
  ed.data("\x05"); // Ctrl-E
  await flush(term);
  assert.deepEqual(caret(term), { x: 3 + 6, y: 0 });
});

test("Backspace deletes left of the caret, Delete under it", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("abcd");
  ed.data(LEFT); // caret between c and d
  ed.data(BS); // kill c
  await flush(term);
  assert.equal(row(term, 0), "p$ abd");
  assert.deepEqual(caret(term), { x: 3 + 2, y: 0 });
  ed.data(HOME);
  ed.data(DEL); // kill a
  await flush(term);
  assert.equal(row(term, 0), "p$ bd");
  assert.deepEqual(caret(term), { x: 3, y: 0 });
  ed.data("\r");
  assert.deepEqual(submitted, ["bd"]);
});

test("Ctrl-U/Ctrl-K kill to the line edges, Ctrl-W kills the word left", async () => {
  const { term, ed } = makeEditor();
  ed.data("one two three");
  type(ed, [LEFT, LEFT, LEFT, LEFT, LEFT]); // caret after "two "
  ed.data("\x15"); // Ctrl-U
  await flush(term);
  assert.equal(row(term, 0), "p$ three");
  assert.deepEqual(caret(term), { x: 3, y: 0 });

  ed.data(END);
  ed.data("\x17"); // Ctrl-W → kills "three"
  await flush(term);
  // The prompt's trailing space is a REAL cell — translateToString keeps it.
  assert.equal(row(term, 0), "p$ ");

  ed.data("abc def");
  ed.data(HOME);
  type(ed, [RIGHT, RIGHT, RIGHT]);
  ed.data("\x0b"); // Ctrl-K
  await flush(term);
  assert.equal(row(term, 0), "p$ abc");
  assert.deepEqual(caret(term), { x: 3 + 3, y: 0 });
});

test("Ctrl-←/Ctrl-→ hop between words", async () => {
  const { term, ed } = makeEditor();
  ed.data("git push origin");
  ed.data("\x1b[1;5D"); // Ctrl-← → start of "origin"
  await flush(term);
  assert.deepEqual(caret(term), { x: 3 + 9, y: 0 });
  ed.data("\x1b[1;5D");
  ed.data("\x1b[1;5D");
  await flush(term);
  assert.deepEqual(caret(term), { x: 3, y: 0 });
  ed.data("\x1b[1;5C"); // Ctrl-→ → end of "git"
  await flush(term);
  assert.deepEqual(caret(term), { x: 3 + 3, y: 0 });
});

test("↑/↓ browse history and restore the in-progress draft", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("first");
  ed.data("\r");
  ed.freshPrompt(); // the component re-prompts after each round-trip
  ed.data("second");
  ed.data("\r");
  ed.freshPrompt();
  assert.deepEqual(submitted, ["first", "second"]);

  ed.data("dra"); // in-progress draft
  ed.data(UP);
  await flush(term);
  assert.equal(row(term, 2), "p$ second");
  ed.data(UP);
  await flush(term);
  assert.equal(row(term, 2), "p$ first");
  ed.data(UP); // clamped at the oldest
  await flush(term);
  assert.equal(row(term, 2), "p$ first");
  ed.data(DOWN);
  await flush(term);
  assert.equal(row(term, 2), "p$ second");
  ed.data(DOWN); // past the newest → the draft comes back
  await flush(term);
  assert.equal(row(term, 2), "p$ dra");
  ed.data(DOWN); // and ↓ at the draft is a no-op that keeps ↑ working
  ed.data(UP);
  await flush(term);
  assert.equal(row(term, 2), "p$ second");
});

test("history entry can be edited mid-line before resubmit", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("cat /etc/hosts");
  ed.data("\r");
  ed.freshPrompt();
  ed.data(UP);
  type(ed, [LEFT, LEFT, LEFT, LEFT, LEFT]); // caret before "hosts"
  ed.data(BS); // kill the second "/"
  await flush(term);
  assert.equal(row(term, 1), "p$ cat /etchosts");
  ed.data("\r");
  assert.deepEqual(submitted, ["cat /etc/hosts", "cat /etchosts"]);
});

test("a line wrapping across rows stays editable (Home, mid-line insert)", async () => {
  const { term, ed, submitted } = makeEditor({ cols: 20 });
  const text = "abcdefghij0123456789xyz"; // 3 + 23 visible → 2 rows
  ed.data(text);
  await flush(term);
  assert.equal(row(term, 0), "p$ abcdefghij0123456");
  assert.equal(row(term, 1), "789xyz");
  assert.deepEqual(caret(term), { x: 6, y: 1 });

  ed.data(HOME);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3, y: 0 });
  ed.data("Z"); // insert at the head — everything shifts one cell
  await flush(term);
  assert.equal(row(term, 0), "p$ Zabcdefghij012345");
  assert.equal(row(term, 1), "6789xyz");
  assert.deepEqual(caret(term), { x: 4, y: 0 });

  ed.data("\r");
  assert.deepEqual(submitted, ["Zabcdefghij0123456789xyz"]);
});

test("← walks back across the wrap boundary", async () => {
  const { term, ed } = makeEditor({ cols: 20 });
  ed.data("abcdefghij0123456"); // fills row 0 exactly (3 + 17 = 20)
  ed.data("XY");
  await flush(term);
  assert.equal(row(term, 1), "XY");
  type(ed, [LEFT, LEFT]); // caret at col 0 of row 1
  await flush(term);
  assert.deepEqual(caret(term), { x: 0, y: 1 });
  ed.data(LEFT); // …and once more jumps to the end of row 0
  await flush(term);
  assert.deepEqual(caret(term), { x: 19, y: 0 });
});

test("input ending exactly at the row boundary keeps a determinate caret", async () => {
  const { term, ed, submitted } = makeEditor({ cols: 20 });
  ed.data("abcdefghij0123456"); // 3 + 17 = 20 → exact boundary
  await flush(term);
  assert.deepEqual(caret(term), { x: 0, y: 1 });
  ed.data("Z"); // typing continues on the wrapped row
  await flush(term);
  assert.equal(row(term, 1), "Z");
  assert.deepEqual(caret(term), { x: 1, y: 1 });
  type(ed, [BS, BS]); // delete back across the boundary
  await flush(term);
  assert.equal(row(term, 0), "p$ abcdefghij012345");
  assert.deepEqual(caret(term), { x: 19, y: 0 });
  ed.data("\r");
  assert.deepEqual(submitted, ["abcdefghij012345"]);
});

test("editing a wrapped line at the bottom of the screen survives the scroll", async () => {
  const { term, ed, submitted } = makeEditor({ cols: 10, rows: 4 });
  term.write("a\r\nb\r\nc\r\n"); // park the prompt on the last screen row
  await flush(term);
  ed.freshPrompt();
  ed.data("0123456789"); // 3 + 10 → wraps, scrolling the screen by one
  await flush(term);
  assert.equal(row(term, 3), "p$ 0123456");
  assert.equal(row(term, 4), "789");
  assert.deepEqual(caret(term), { x: 3, y: 4 });

  ed.data(HOME);
  await flush(term);
  assert.deepEqual(caret(term), { x: 3, y: 3 });
  ed.data("Z");
  await flush(term);
  assert.equal(row(term, 3), "p$ Z012345");
  assert.equal(row(term, 4), "6789");
  ed.data("\r");
  assert.deepEqual(submitted, ["Z0123456789"]);
});

test("Ctrl-C abandons the line from any caret position", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("abc");
  ed.data(HOME);
  ed.data("\x03");
  await flush(term);
  assert.equal(row(term, 0), "p$ abc^C");
  assert.equal(row(term, 1), "p$ ");
  assert.deepEqual(caret(term), { x: 3, y: 1 });
  ed.data("ok");
  ed.data("\r");
  assert.deepEqual(submitted, ["ok"]);
});

test("Ctrl-L clears the screen but keeps the line and the caret column", async () => {
  const { term, ed } = makeEditor();
  ed.data("abc");
  ed.data(LEFT);
  // term.reset() is synchronous while writes queue — settle first, as the
  // browser always has by the time a separate Ctrl-L keystroke arrives.
  await flush(term);
  ed.data("\x0c");
  await flush(term);
  assert.equal(row(term, 0), "p$ abc");
  assert.equal(row(term, 1), "");
  assert.deepEqual(caret(term), { x: 3 + 2, y: 0 });
});

test("insertAbove slots a note over the prompt and preserves the edit", async () => {
  const { term, ed } = makeEditor();
  ed.data("ab");
  ed.data(LEFT);
  ed.insertAbove("NOTE");
  await flush(term);
  assert.equal(row(term, 0), "NOTE");
  assert.equal(row(term, 1), "p$ ab");
  assert.deepEqual(caret(term), { x: 3 + 1, y: 1 });
});

test("blank Enter re-prompts without submitting; unknown escapes are inert", async () => {
  const { term, ed, submitted } = makeEditor();
  ed.data("\r");
  ed.data("   ");
  ed.data("\r");
  await flush(term);
  assert.deepEqual(submitted, []);
  assert.deepEqual(caret(term), { x: 3, y: 2 });

  ed.data("ok");
  for (const seq of ["\x1bOP", "\x1b[5~", "\x1b[6~", "\x1b[2~"]) ed.data(seq);
  await flush(term);
  assert.equal(row(term, 2), "p$ ok");
  assert.deepEqual(caret(term), { x: 3 + 2, y: 2 });
});

test("resetSession forgets history and the line", async () => {
  const { term, ed } = makeEditor();
  ed.data("secret");
  ed.data("\r");
  ed.freshPrompt();
  await flush(term); // settle the queue before the out-of-band reset
  ed.resetSession();
  term.reset();
  ed.freshPrompt();
  ed.data(UP); // nothing to recall
  await flush(term);
  assert.equal(row(term, 0), "p$ ");
  assert.deepEqual(caret(term), { x: 3, y: 0 });
});
