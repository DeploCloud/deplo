import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Every app and database kebab opens with Rename.
const MENUS: [file: string, start: string][] = [
  ["components/apps/app-controls.tsx", "<DropdownMenuContent"],
  ["components/apps/app-card.tsx", "const menu = (K: MenuKit)"],
  ["components/storage/database-card.tsx", "<DropdownMenuContent"],
  ["components/storage/database-actions-menu.tsx", "<DropdownMenuContent"],
];

for (const [file, start] of MENUS) {
  test(`${file}: Rename is the first menu item`, () => {
    const src = readFileSync(file, "utf8");
    const menu = src.slice(src.indexOf(start));
    const first = menu.match(
      /<(?:K\.Item|DropdownMenuItem)[\s\S]*?<\/(?:K\.Item|DropdownMenuItem)>/,
    );
    assert.ok(first, "no menu item found");
    assert.match(first[0], /\bRename\b/);
    assert.match(src, /<RenameDialog\b/);
  });
}
