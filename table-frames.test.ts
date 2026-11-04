import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

// The Table rounds itself at rounded-xl; a frame of another radius, or none, shows square corners.
test("every table sits in a rounded-xl frame or a Card", () => {
  const offenders: string[] = [];
  for (const file of [...walk("app"), ...walk("components")]) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!/<Table[\s>]/.test(line)) return;
      const above = lines.slice(Math.max(0, i - 3), i).join(" ");
      if (!/rounded-xl|<Card\b/.test(above)) offenders.push(`${file}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test("a table cell keeps its label and its row on one line", async () => {
  const React = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } =
    await import("./components/ui/table");
  const html = renderToStaticMarkup(
    React.createElement(Table, null, [
      React.createElement(
        TableHeader,
        { key: "h" },
        React.createElement(
          TableRow,
          null,
          React.createElement(TableHead, null, "Last seen"),
        ),
      ),
      React.createElement(
        TableBody,
        { key: "b" },
        React.createElement(
          TableRow,
          null,
          React.createElement(TableCell, null, "24 days ago"),
        ),
      ),
    ]),
  );
  assert.match(html, /<th class="[^"]*whitespace-nowrap/);
  assert.match(html, /<td class="[^"]*whitespace-nowrap/);
  assert.match(
    html,
    /overflow-x-auto/,
    "a table too wide for the screen scrolls",
  );
});
