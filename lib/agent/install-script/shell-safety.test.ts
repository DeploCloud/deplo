import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// An UNQUOTED heredoc expands, so a backtick inside one - even in a comment - is a command substitution: every install opened with "-: command not found".
test("no unquoted heredoc runs a command it did not mean to", async () => {
  for (const name of ["install-agent.sh", "install.sh", "uninstall.sh"]) {
    const text = await readFile(join(process.cwd(), name), "utf8").catch(
      () => "",
    );
    if (!text) continue;
    let delim: string | null = null;
    let expands = false;
    text.split("\n").forEach((line, i) => {
      if (delim === null) {
        const m =
          /<<-?\s*(?:'([A-Za-z_][A-Za-z0-9_]*)'|"?([A-Za-z_][A-Za-z0-9_]*)"?)\s*$/.exec(
            line,
          );
        if (m) {
          delim = m[1] ?? m[2];
          expands = m[1] === undefined;
        }
        return;
      }
      if (line.trim() === delim) {
        delim = null;
        return;
      }
      if (!expands) return;
      const live = line.replace(/\\[`$]/g, "");
      assert.ok(
        !live.includes("`") && !live.includes("$("),
        `${name}:${i + 1} substitutes a command inside a heredoc: ${line.trim()}`,
      );
    });
  }
});
