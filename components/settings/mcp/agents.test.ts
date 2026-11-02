import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENTS } from "./agents";

const args = { url: "https://deplo.example.com/api/mcp", token: "deplo_x" };

describe("MCP agent setup", () => {
  // The picker's cards are narrow: the longest blurb that still fits is "Something else"'s.
  it("keeps every blurb to one line of the agent picker", () => {
    const fits = AGENTS.find((a) => a.id === "other")!.blurb.length;
    for (const a of AGENTS)
      assert.ok(a.blurb.length <= fits, `${a.id}: "${a.blurb}"`);
  });

  // A per-project setup vanishes in every other folder and leaks the token into a repo.
  it("installs every agent for the whole machine, never one project", () => {
    for (const a of AGENTS.filter((a) => a.kind === "token")) {
      if (a.form === "command") {
        assert.match(a.snippet(args), /--scope user/, a.id);
      } else if (a.file) {
        assert.ok(a.file.startsWith("~/") || a.file === "mcp.json", a.id);
      }
    }
  });
});
