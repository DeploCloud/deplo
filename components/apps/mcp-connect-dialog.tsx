"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowUpRight, KeyRound } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { CodeBlock } from "@/components/shared/code-block";
import { CopyButton } from "@/components/shared/copy-button";

/**
 * The MCP connect dialog, shown after installing (or from the card menu of) the
 * MCP app. It reveals the app-path endpoint and a copyable client-config
 * snippet, and points the user to Settings → API Tokens to mint their OWN
 * caller token — Deplo generates and reveals NOTHING here (the only credential
 * is the user's own `deplo_` token, forwarded verbatim by the stateless relay).
 */
export function McpConnectDialog({
  open,
  onOpenChange,
  endpoint,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The app-path MCP endpoint, e.g. `https://<deplo>/apps/mcp-acme/mcp`. */
  endpoint: string;
}) {
  // A Streamable-HTTP MCP client config (Claude Desktop / Cursor style). The
  // user pastes their OWN minted token in place of the placeholder.
  const clientConfig = JSON.stringify(
    {
      mcpServers: {
        deplo: {
          type: "http",
          url: endpoint,
          headers: { Authorization: "Bearer deplo_YOUR_TOKEN" },
        },
      },
    },
    null,
    2,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect your AI assistant</DialogTitle>
          <DialogDescription>
            The MCP app is a stateless relay — it holds no credential of its own.
            Mint a <span className="font-medium">caller token</span> and paste it
            into your MCP client as the bearer; the app forwards it verbatim to
            Deplo&apos;s API, so it can only do what your token allows.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              MCP endpoint
            </p>
            <div className="flex items-center gap-2 rounded-lg border border-border bg-[#0a0a0a] px-3 py-2">
              <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-sm text-zinc-200">
                {endpoint}
              </code>
              <CopyButton value={endpoint} />
            </div>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              Client config
            </p>
            <CodeBlock code={clientConfig} language="json" />
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 p-3 text-sm">
            <KeyRound className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <p className="text-muted-foreground">
              Deplo reveals no secret here. Mint your own token in{" "}
              <span className="font-medium text-foreground">
                Settings → API Tokens
              </span>{" "}
              and use it as the bearer above. Revoking it cuts off only your
              client.
            </p>
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
          <Button asChild>
            <Link href="/settings/tokens">
              Mint a token
              <ArrowUpRight className="size-4" />
            </Link>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
