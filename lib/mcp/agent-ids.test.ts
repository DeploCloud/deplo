import test from "node:test";
import assert from "node:assert/strict";

import { agentFromClientName, agentFromRedirect } from "./agent-ids";

test("a client's own name maps to the most specific agent", () => {
  assert.equal(agentFromClientName("claude-code"), "claude-code");
  assert.equal(agentFromClientName("claude-ai"), "claude-web");
  assert.equal(agentFromClientName("cursor-vscode"), "cursor");
  assert.equal(agentFromClientName("Visual Studio Code"), "vscode");
  assert.equal(agentFromClientName("gemini-cli-mcp-client"), "gemini-cli");
  assert.equal(agentFromClientName("antigravity"), "antigravity");
  assert.equal(agentFromClientName("codex-mcp-client"), "codex-cli");
  assert.equal(agentFromClientName("openai-mcp"), "chatgpt");
  assert.equal(agentFromClientName("my-own-script"), null);
});

test("an OAuth connector is known by where it sends the user back", () => {
  assert.equal(
    agentFromRedirect("https://claude.ai/api/mcp/auth_callback"),
    "claude-web",
  );
  assert.equal(
    agentFromRedirect("https://chatgpt.com/connector_platform_oauth_redirect"),
    "chatgpt",
  );
  assert.equal(agentFromRedirect("https://notclaude.ai/cb"), null);
  assert.equal(agentFromRedirect(null), null);
});
