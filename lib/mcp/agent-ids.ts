// The agents the connect wizard knows, as stored on api_tokens.mcp_agent.
export const MCP_AGENT_IDS = [
  "claude-web",
  "chatgpt",
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "antigravity",
  "gemini-cli",
  "codex-cli",
  "other",
] as const;

export type McpAgentId = (typeof MCP_AGENT_IDS)[number];

export function isMcpAgentId(v: unknown): v is McpAgentId {
  return (MCP_AGENT_IDS as readonly unknown[]).includes(v);
}

// Most specific first: "claude-code" before "claude", "cursor-vscode" before "vscode".
const CLIENT_NAMES: [RegExp, McpAgentId][] = [
  [/claude[-_ ]?code/i, "claude-code"],
  [/claude/i, "claude-web"],
  [/cursor/i, "cursor"],
  [/windsurf|codeium|cascade/i, "windsurf"],
  [/antigravity/i, "antigravity"],
  [/gemini/i, "gemini-cli"],
  [/codex/i, "codex-cli"],
  [/chatgpt|openai/i, "chatgpt"],
  [/visual studio code|vscode|copilot/i, "vscode"],
];

// What an MCP client calls itself in `initialize` (clientInfo.name).
export function agentFromClientName(name: string): McpAgentId | null {
  return CLIENT_NAMES.find(([re]) => re.test(name))?.[1] ?? null;
}

// Where an OAuth connector sends the user back after approving.
export function agentFromRedirect(
  url: string | null | undefined,
): McpAgentId | null {
  let host: string;
  try {
    host = new URL(url ?? "").hostname;
  } catch {
    return null;
  }
  if (/(^|\.)claude\.(ai|com)$/.test(host)) return "claude-web";
  if (/(^|\.)(chatgpt|openai)\.com$/.test(host)) return "chatgpt";
  return null;
}
