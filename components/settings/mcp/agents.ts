import type * as React from "react";
import type { LogoAccent } from "@/lib/templates/logo-color";
import { Bot } from "lucide-react";
import type { McpAgentId } from "@/lib/mcp/agent-ids";
import {
  ClaudeIcon,
  CursorIcon,
  GeminiIcon,
  OpenAiIcon,
  VsCodeIcon,
  WindsurfIcon,
} from "@/components/shared/brand-icons";

export type AgentId = McpAgentId;

export interface AgentDef {
  id: AgentId;
  label: string;
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  brand?: { bg: string; fg: string };
  veil?: LogoAccent;
  kind: "web" | "token";
  file?: string;
  form: "command" | "file";
  language?: string;
  hint: string;
  docsUrl: string;
  snippet: (a: { url: string; token: string }) => string;
}

export const TOKEN_PLACEHOLDER = "deplo_your_token";

const webSnippet = ({ url }: { url: string }) => url;

export const AGENTS: AgentDef[] = [
  {
    id: "claude-web",
    label: "Claude",
    blurb: "claude.ai. Sign in and approve once.",
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
    blurb: "chatgpt.com, in developer mode.",
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
    blurb: "The app for Mac and Windows.",
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
    blurb: "One command in your terminal.",
    icon: ClaudeIcon,
    brand: { bg: "#D97757", fg: "#FFFFFF" },
    veil: { hue: 39 },
    kind: "token",
    form: "command",
    hint: "Paste it into your terminal and run it once.",
    docsUrl: "https://code.claude.com/docs/en/mcp",
    snippet: ({ url, token }) =>
      `claude mcp add --transport http Deplo ${url} --header "Authorization: Bearer ${token}"`,
  },
  {
    id: "cursor",
    label: "Cursor",
    blurb: "A config file in your repo.",
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
    blurb: "Copilot agent mode, once per repo.",
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
    blurb: "Set up once for your whole machine.",
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
    blurb: "One entry in its settings file.",
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
    blurb: "One entry in its config file.",
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
    blurb: "Any other MCP client, set up by hand.",
    icon: Bot,
    kind: "token",
    form: "file",
    hint: "Two lines every MCP client asks for. Deplo speaks Streamable HTTP, protocol revision 2026-07-28.",
    docsUrl: "https://modelcontextprotocol.io/docs/concepts/transports",
    snippet: ({ url, token }) =>
      `URL:    ${url}\nHeader: Authorization: Bearer ${token}`,
  },
];
