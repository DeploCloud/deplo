/**
 * The AI agents deplo knows how to connect, and the exact configuration each one
 * wants. The wizard branches on `kind` and never shows one audience the other's
 * instructions. `docsUrl` is on every entry because these formats move.
 */

import type * as React from "react";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { Bot } from "lucide-react";
import {
  ClaudeIcon,
  CursorIcon,
  GeminiIcon,
  OpenAiIcon,
  VsCodeIcon,
  WindsurfIcon,
} from "@/components/shared/brand-icons";

export type AgentId =
  | "claude-web"
  | "chatgpt"
  | "claude-desktop"
  | "claude-code"
  | "cursor"
  | "vscode"
  | "windsurf"
  | "gemini-cli"
  | "codex-cli"
  | "other";

export interface AgentDef {
  id: AgentId;
  label: string;
  /**
   * The line under the name. What the reader needs in order to recognise theirs
   * and know the one thing that will surprise them, not a pitch.
   */
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * The agent's own colours, as a tile behind its mark. Literal hexes and not
   * tokens, because a brand colour is not themeable - the tile carries its own
   * foreground so it is legible on either theme's background.
   */
  brand?: { bg: string; fg: string };
  /**
   * The wash the whole card wears on hover and once chosen, in the same grammar
   * the template store uses (`veilProps`): a hue when the brand has one, its own
   * ink when it does not.
   */
  veil?: LogoAccent;
  /**
   * `web` connects over OAuth and is minted by the consent screen; `token`
   * carries a `deplo_` bearer the wizard creates.
   */
  kind: "web" | "token";
  /** The file the snippet goes in, shown as the code block's filename. */
  file?: string;
  /** How the snippet is rendered: a shell command, or a file's contents. */
  form: "command" | "file";
  /** Language hint for the code block. */
  language?: string;
  /**
   * How to get there, in one sentence - the exact path through that client's own
   * UI, in that client's own words.
   */
  hint: string;
  docsUrl: string;
  /**
   * The configuration itself. `token` is the real secret for a token client and
   * empty for a web one (which never sees a token here).
   */
  snippet: (a: { url: string; token: string }) => string;
}

/** Shown while the wizard has a client picked but no token minted yet. */
export const TOKEN_PLACEHOLDER = "deplo_your_token";

/** Claude, ChatGPT and Claude Desktop all take the bare URL and nothing else. */
const webSnippet = ({ url }: { url: string }) => url;

export const AGENTS: AgentDef[] = [
  {
    id: "claude-web",
    label: "Claude",
    blurb: "The assistant at claude.ai. Sign in and approve it once.",
    icon: ClaudeIcon,
    brand: { bg: "#D97757", fg: "#FFFFFF" },
    veil: { hue: 39 },
    kind: "web",
    form: "file",
    hint: "In Claude, open Customize → Connectors, press + and choose Add custom connector.",
    docsUrl:
      "https://support.claude.com/en/articles/11175166-about-custom-connectors-via-remote-mcp-servers",
    snippet: webSnippet,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    blurb: "The assistant at chatgpt.com. Needs developer mode on.",
    icon: OpenAiIcon,
    brand: { bg: "#000000", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "web",
    form: "file",
    hint: "In ChatGPT, open Settings → Apps & Connectors → Advanced settings, turn on Developer mode, then press Create.",
    docsUrl:
      "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt",
    snippet: webSnippet,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    blurb: "The Claude app for Mac and Windows. Same flow, no token.",
    icon: ClaudeIcon,
    brand: { bg: "#D97757", fg: "#FFFFFF" },
    veil: { hue: 39 },
    kind: "web",
    form: "file",
    hint: "In Claude, open Customize → Connectors, press + and choose Add custom connector.",
    docsUrl:
      "https://support.claude.com/en/articles/11175166-about-custom-connectors-via-remote-mcp-servers",
    snippet: webSnippet,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    blurb: "The terminal agent. One command in your shell and done.",
    icon: ClaudeIcon,
    brand: { bg: "#D97757", fg: "#FFFFFF" },
    veil: { hue: 39 },
    kind: "token",
    form: "command",
    hint: "Run it once in your terminal. Add --scope user to reuse it in every project.",
    docsUrl: "https://code.claude.com/docs/en/mcp",
    snippet: ({ url, token }) =>
      `claude mcp add --transport http deplo ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: "cursor",
    label: "Cursor",
    blurb: "The AI editor. Its config file lives in your own repo.",
    icon: CursorIcon,
    brand: { bg: "#000000", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "token",
    file: ".cursor/mcp.json",
    form: "file",
    language: "json",
    hint: "Save it in your repo, or in ~/.cursor/mcp.json to use it everywhere.",
    docsUrl: "https://cursor.com/docs/mcp",
    snippet: ({ url, token }) =>
      JSON.stringify(
        {
          mcpServers: {
            deplo: {
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: "vscode",
    label: "VS Code",
    blurb: "GitHub Copilot's agent mode. Configured once per repo.",
    icon: VsCodeIcon,
    brand: { bg: "#007ACC", fg: "#FFFFFF" },
    veil: { hue: 249 },
    kind: "token",
    file: ".vscode/mcp.json",
    form: "file",
    language: "json",
    hint: "Save it in your repo, then run MCP: List Servers from the Command Palette to start it.",
    docsUrl:
      "https://code.visualstudio.com/docs/copilot/customization/mcp-servers",
    snippet: ({ url, token }) =>
      JSON.stringify(
        {
          servers: {
            deplo: {
              type: "http",
              url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: "windsurf",
    label: "Windsurf",
    blurb: "Cascade's agent. Configured once for your whole machine.",
    icon: WindsurfIcon,
    brand: { bg: "#0B100F", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "token",
    file: "~/.codeium/windsurf/mcp_config.json",
    form: "file",
    language: "json",
    hint: "Save it, then open the MCPs icon in Cascade's top-right menu.",
    docsUrl: "https://docs.windsurf.com/windsurf/cascade/mcp",
    snippet: ({ url, token }) =>
      JSON.stringify(
        {
          mcpServers: {
            deplo: {
              serverUrl: url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: "gemini-cli",
    label: "Gemini CLI",
    blurb: "Google's terminal agent. One entry in its settings file.",
    icon: GeminiIcon,
    brand: { bg: "#8E75B2", fg: "#FFFFFF" },
    veil: { hue: 303 },
    kind: "token",
    file: "~/.gemini/settings.json",
    form: "file",
    language: "json",
    hint: "Merge it into the file, then run /mcp in the CLI to check Deplo is listed.",
    docsUrl:
      "https://google-gemini.github.io/gemini-cli/docs/tools/mcp-server.html",
    snippet: ({ url, token }) =>
      JSON.stringify(
        {
          mcpServers: {
            deplo: {
              httpUrl: url,
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ),
  },
  {
    id: "codex-cli",
    label: "Codex CLI",
    blurb: "OpenAI's terminal agent. Its config file is TOML, not JSON.",
    icon: OpenAiIcon,
    brand: { bg: "#000000", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "token",
    file: "~/.codex/config.toml",
    form: "file",
    language: "toml",
    hint: "Append it to the file, then run /mcp in a Codex session to check Deplo is connected.",
    docsUrl: "https://learn.chatgpt.com/docs/extend/mcp?surface=cli",
    snippet: ({ url, token }) =>
      [
        "[mcp_servers.deplo]",
        `url = "${url}"`,
        `http_headers = { "Authorization" = "Bearer ${token}" }`,
      ].join("\n"),
  },
  {
    id: "other",
    label: "Something else",
    blurb: "Any other client that speaks Streamable HTTP with a header.",
    icon: Bot,
    kind: "token",
    form: "file",
    // The connection details, not a curl.
    hint: "Two lines every MCP client asks for. Deplo speaks Streamable HTTP, protocol revision 2026-07-28.",
    docsUrl: "https://modelcontextprotocol.io/docs/concepts/transports",
    snippet: ({ url, token }) =>
      `URL:    ${url}\nHeader: Authorization: Bearer ${token}`,
  },
];

export function agentById(id: AgentId): AgentDef {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[AGENTS.length - 1];
}
