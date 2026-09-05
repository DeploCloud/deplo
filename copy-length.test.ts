import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * UI copy is short: a modal description is one sentence, a tooltip carries the
 * constraint, and anything longer is a `<DocsLink>` away in the manual.
 */
const MODAL = 120;
const TOOLTIP = 160;
const PARAGRAPH = 200;

/** Components whose `description` is a modal's, not a card's. */
const MODALS = new Set([
  "ConfirmAction",
  "DeleteWithArtifacts",
  "UnsavedChangesGuard",
]);

function walk(dir: string, out: string[] = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".tsx") && !p.endsWith(".test.tsx")) out.push(p);
  }
  return out;
}

/** The JSX expression starting at `{`, up to its matching brace. */
function braced(src: string, start: number) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

function skipString(src: string, start: number) {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === "\\") i++;
    else if (src[i] === quote) return i;
  }
  return src.length;
}

/** Drop every `{...}` expression, braces balanced, so a ternary is not read as
 *  prose. */
function stripExpressions(value: string) {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "{") {
      i += braced(value, i).length - 1;
      out += " ";
    } else out += value[i];
  }
  return out;
}

/** Every sentence a reader can end up seeing: the static JSX text, and each
 *  literal a branch may render. */
function sentences(value: string): string[] {
  const literals = [
    ...value.matchAll(/"((?:[^"\\]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g),
  ]
    .map((m) => (m[1] ?? m[2]).replace(/\$\{[^}]*\}/g, ""))
    .filter((s) => /[.,:;?]/.test(s));
  const staticText = stripExpressions(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/&\w+;/g, "'");
  return [staticText, ...literals].map((s) => s.replace(/\s+/g, " ").trim());
}

const files = [...walk("components"), ...walk("app")];

function offenders(find: (src: string) => Array<[string, number]>) {
  const bad: string[] = [];
  for (const f of files)
    for (const [value, cap] of find(readFileSync(f, "utf8")))
      for (const s of sentences(value))
        if (s.length > cap)
          bad.push(`${f}: ${s.length}/${cap} - ${s.slice(0, 60)}`);
  return bad;
}

test("a modal says it in one sentence", () => {
  const bad = offenders((src) => {
    const found: Array<[string, number]> = [];
    for (const m of src.matchAll(
      /<(?:Dialog|Sheet)Description[^>]*>([\s\S]*?)<\/(?:Dialog|Sheet)Description>/g,
    ))
      found.push([m[1], MODAL]);
    return found;
  });
  assert.deepEqual(
    bad,
    [],
    `shorten it, or move the rest behind a DocsLink:\n${bad.join("\n")}`,
  );
});

test("a description prop stays inside its cap", () => {
  const bad = offenders((src) => {
    const found: Array<[string, number]> = [];
    for (const m of src.matchAll(/\b(?:description|lead)=(["{])/g)) {
      const at = m.index + m[0].length - 1;
      const value =
        m[1] === '"' ? src.slice(at, skipString(src, at) + 1) : braced(src, at);
      const tag = src.slice(0, m.index).match(/<([A-Z]\w*)[^<>]*$/)?.[1] ?? "";
      found.push([value, MODALS.has(tag) ? MODAL : PARAGRAPH]);
    }
    return found;
  });
  assert.deepEqual(
    bad,
    [],
    `shorten it, or move the rest behind a DocsLink:\n${bad.join("\n")}`,
  );
});

test("a tooltip carries the constraint, not the chapter", () => {
  const bad = offenders((src) => {
    const found: Array<[string, number]> = [];
    for (const m of src.matchAll(/\b(?:info|content)=(["{])/g)) {
      const at = m.index + m[0].length - 1;
      found.push([
        m[1] === '"' ? src.slice(at, skipString(src, at) + 1) : braced(src, at),
        TOOLTIP,
      ]);
    }
    return found;
  });
  assert.deepEqual(
    bad,
    [],
    `shorten it, or move the rest behind a DocsLink:\n${bad.join("\n")}`,
  );
});

test("a muted paragraph is not an essay", () => {
  const bad = offenders((src) => {
    const found: Array<[string, number]> = [];
    for (const m of src.matchAll(
      /<p className="[^"]*text-muted-foreground[^"]*"[^>]*>([\s\S]*?)<\/p>/g,
    ))
      found.push([m[1], PARAGRAPH]);
    return found;
  });
  assert.deepEqual(
    bad,
    [],
    `shorten it, or move the rest behind a DocsLink:\n${bad.join("\n")}`,
  );
});
