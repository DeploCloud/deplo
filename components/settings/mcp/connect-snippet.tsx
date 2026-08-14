"use client";

import * as React from "react";
import Link from "next/link";
import { ExternalLink } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CodeBlock, CommandLine } from "@/components/shared/code-block";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";

/**
 * The one-line connect instructions, per client.
 *
 * The whole point of the MCP server is that connecting an agent is a copied
 * line, so this is the page's centre of gravity: pick the client, copy, done.
 * The token is never minted here — it comes from Settings → API tokens, which
 * stays the single place a deplo secret is born and the single place it is
 * revoked.
 */

type ClientId = "claude-code" | "mcp-json" | "curl";

const CLIENTS: { id: ClientId; label: string; hint: string }[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    hint: "Run this once in your terminal. Add --scope user to reuse it in every project.",
  },
  {
    id: "mcp-json",
    label: "Cursor, VS Code, Windsurf",
    hint: "Save this as .mcp.json in your repo. The token stays in your environment, not in the file.",
  },
  {
    id: "curl",
    label: "Anything else",
    hint: "Any MCP client that speaks Streamable HTTP and can send a header.",
  },
];

export function ConnectSnippet({
  publicUrl,
  teamSlug,
}: {
  publicUrl: string;
  teamSlug: string;
}) {
  const [client, setClient] = React.useState<ClientId>("claude-code");
  const host = publicUrl.replace(/\/+$/, "") || "https://your-deplo-host";
  const url = `${host}/api/mcp`;
  const current = CLIENTS.find((c) => c.id === client)!;

  const snippet =
    client === "claude-code"
      ? `claude mcp add --transport http deplo ${url} --header "Authorization: Bearer deplo_your_token" --header "X-Deplo-Team: ${teamSlug}"`
      : client === "curl"
        ? `curl -X POST ${url} -H "Authorization: Bearer deplo_your_token" -H "X-Deplo-Team: ${teamSlug}" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`
        : JSON.stringify(
            {
              mcpServers: {
                deplo: {
                  type: "http",
                  url,
                  headers: {
                    Authorization: "Bearer ${DEPLO_TOKEN}",
                    "X-Deplo-Team": teamSlug,
                  },
                },
              },
            },
            null,
            2,
          );

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-4 space-y-0">
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Connect an agent
          <InfoTip content="One endpoint serves one team. To work in another team, connect a second MCP server with its slug." />
        </CardTitle>
        <Select value={client} onValueChange={(v) => setClient(v as ClientId)}>
          <SelectTrigger className="w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CLIENTS.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="space-y-3">
        {client === "mcp-json" ? (
          <CodeBlock code={snippet} filename=".mcp.json" />
        ) : (
          <CommandLine command={snippet} />
        )}
        <p className="text-xs text-muted-foreground">{current.hint}</p>
        <p className="text-sm">
          <Link
            href="/settings/tokens/new?preset=mcp"
            className="inline-flex items-center gap-1 font-medium underline underline-offset-4"
          >
            Create a token for this
            <ExternalLink className="size-3.5" />
          </Link>{" "}
          <span className="text-muted-foreground">
            — the MCP template grants what an assistant needs and nothing that
            can leak a secret.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}
