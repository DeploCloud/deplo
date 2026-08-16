/**
 * The AI agents deplo knows how to connect, and the exact configuration each
 * one wants.
 *
 * Two shapes, and the split is not cosmetic. A **web** client (claude.ai,
 * ChatGPT, Claude Desktop) has no field to paste a header into: it discovers the
 * server, registers itself and sends the person through deplo's OAuth consent
 * screen, which is where the credential is minted (ADR-0022). A **token** client
 * is a terminal or an editor, and it wants a config file or a command with an
 * `Authorization` header in it. The wizard branches on `kind` and never shows
 * one audience the other's instructions.
 *
 * The snippets are per client on purpose. This page used to offer ONE `.mcp.json`
 * labelled "Cursor, VS Code, Windsurf", and all three disagree: VS Code's file is
 * keyed `servers` (not `mcpServers`), Windsurf spells the address `serverUrl`
 * (not `url`), Gemini spells it `httpUrl`, and Codex is TOML. A snippet that does
 * not work is worse than no snippet, because it costs the reader the twenty
 * minutes they spend trusting it.
 *
 * No `X-Deplo-Team` header anywhere. The wizard mints the token scoped to the
 * active team, so `identityForTokenRow` resolves exactly one team and the header
 * would be restating what the credential already says. It is documented for the
 * hand-written case (`docs/api/graphql.md`) and stays available; it is not
 * something anyone should have to copy correctly to get started.
 *
 * `docsUrl` is on every entry because these formats move. When one changes, the
 * reader should be one click from the truth rather than one search away.
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
   * The line under the name. **Two lines' worth, every time.**
   *
   * That means 40-48 characters, and the band is narrow for a reason: the
   * column these cards live in is ~36 characters wide at its widest and ~29 at
   * its narrowest, so anything under 36 collapses to one line on a big screen
   * and anything over 58 spills to three on a laptop. Sixty-character blurbs
   * did exactly that — one card grew and took its whole row with it, which is a
   * grid you have to re-scan on every glance.
   *
   * What the reader needs in order to recognise theirs and know the one thing
   * that will surprise them, not a pitch.
   */
  blurb: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * The agent's own colours, as a tile behind its mark.
   *
   * The same reasoning `CHANNEL_BRAND` spells out: ten identical grey tiles are
   * ten things you have to READ to tell apart, and the point of this grid is
   * that you spot yours without reading. Literal hexes and not tokens, because
   * a brand colour is not themeable — the tile carries its own foreground so it
   * is legible on either theme's background.
   *
   * Absent on "Something else", which is not a brand and gets the neutral tile.
   */
  brand?: { bg: string; fg: string };
  /**
   * The wash the whole card wears on hover and once chosen, in the same
   * grammar the template store uses (`veilProps`): a hue when the brand has
   * one, its own ink when it does not. Derived once from `brand.bg` in OKLCH —
   * the three near-black marks come out at chroma ~0, which is exactly the case
   * `tone` exists for.
   *
   * Absent on "Something else", which has no brand and stays a plain card.
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
  /** Where to paste it, in one sentence. Rendered under the snippet. */
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
    blurb: "The assistant at claude.ai. Approve it once.",
    icon: ClaudeIcon,
    brand: { bg: "#D97757", fg: "#FFFFFF" },
    veil: { hue: 39 },
    kind: "web",
    form: "file",
    hint: "Settings → Connectors → Add custom connector, then paste this and approve when deplo asks.",
    docsUrl:
      "https://support.claude.com/en/articles/11175166-about-custom-connectors-via-remote-mcp-servers",
    snippet: webSnippet,
  },
  {
    id: "chatgpt",
    label: "ChatGPT",
    blurb: "At chatgpt.com. Needs developer mode on.",
    icon: OpenAiIcon,
    brand: { bg: "#000000", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "web",
    form: "file",
    hint: "Settings → Connectors → Advanced settings → Developer mode, then Create and paste this.",
    docsUrl:
      "https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt",
    snippet: webSnippet,
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    blurb: "The Claude app for Mac and Windows. Same flow.",
    icon: ClaudeIcon,
    brand: { bg: "#D97757", fg: "#FFFFFF" },
    veil: { hue: 39 },
    kind: "web",
    form: "file",
    hint: "Settings → Connectors → Add custom connector, then paste this and approve when deplo asks.",
    docsUrl:
      "https://support.claude.com/en/articles/11175166-about-custom-connectors-via-remote-mcp-servers",
    snippet: webSnippet,
  },
  {
    id: "claude-code",
    label: "Claude Code",
    blurb: "The terminal agent. One command and done.",
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
    blurb: "The editor. Its config file lives in the repo.",
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
    blurb: "Copilot's agent mode. Configured per repo.",
    icon: VsCodeIcon,
    brand: { bg: "#007ACC", fg: "#FFFFFF" },
    veil: { hue: 249 },
    kind: "token",
    file: ".vscode/mcp.json",
    form: "file",
    language: "json",
    hint: "Save it in your repo, then start the server from the Play button VS Code shows above it.",
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
    blurb: "Cascade. Configured once for your machine.",
    icon: WindsurfIcon,
    brand: { bg: "#0B100F", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "token",
    file: "~/.codeium/windsurf/mcp_config.json",
    form: "file",
    language: "json",
    hint: "Save it, then press Refresh in Cascade's MCP panel.",
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
    blurb: "Google's terminal agent. One settings entry.",
    icon: GeminiIcon,
    brand: { bg: "#8E75B2", fg: "#FFFFFF" },
    veil: { hue: 303 },
    kind: "token",
    file: "~/.gemini/settings.json",
    form: "file",
    language: "json",
    hint: "Merge it into the file, then run /mcp in the CLI to check deplo is listed.",
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
    blurb: "OpenAI's terminal agent. Its config is TOML.",
    icon: OpenAiIcon,
    brand: { bg: "#000000", fg: "#FFFFFF" },
    veil: { tone: "dark" },
    kind: "token",
    file: "~/.codex/config.toml",
    form: "file",
    language: "toml",
    hint: "Append it to the file, then run /mcp in a Codex session to check deplo is connected.",
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
    blurb: "Any client on Streamable HTTP with a header.",
    icon: Bot,
    kind: "token",
    form: "file",
    // The connection details, not a curl. A raw JSON-RPC call against protocol
    // revision 2026-07-28 needs an `MCP-Method` header and a `_meta` block
    // carrying the protocol version, which is three lines of ceremony nobody
    // types by hand and every real client sends for you. What a person actually
    // has to know is the address and the header.
    hint: "Two lines every MCP client asks for. deplo speaks Streamable HTTP, protocol revision 2026-07-28.",
    docsUrl: "https://modelcontextprotocol.io/docs/concepts/transports",
    snippet: ({ url, token }) =>
      `URL:    ${url}\nHeader: Authorization: Bearer ${token}`,
  },
];

export function agentById(id: AgentId): AgentDef {
  return AGENTS.find((a) => a.id === id) ?? AGENTS[AGENTS.length - 1];
}
