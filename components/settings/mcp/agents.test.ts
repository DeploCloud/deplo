import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AGENTS } from "./agents";

const args = { url: "https://deplo.example.com/api/mcp", token: "deplo_x" };

describe("MCP agent setup", () => {
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
