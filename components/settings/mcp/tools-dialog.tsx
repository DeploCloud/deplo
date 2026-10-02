"use client";

import * as React from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ToolCatalog, ToolSearch, type McpToolSummary } from "./tool-catalog";

export function ToolsDialog({
  tools,
  highlight,
  trigger,
}: {
  tools: McpToolSummary[];
  highlight?: string[];
  trigger: React.ReactNode;
}) {
  const [query, setQuery] = React.useState("");

  return (
    <Dialog>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        selfManaged
        className="grid h-[min(85vh,44rem)] grid-rows-[auto_minmax(0,1fr)] gap-0 p-0 sm:max-w-2xl"
      >
        <DialogHeader className="space-y-0 border-b border-border p-6 pb-4">
          <DialogTitle className="text-base lg:text-lg">
            What an agent can do
          </DialogTitle>
          <DialogDescription className="mt-1">
            An agent only sees the tools its token can use. Secrets are never
            readable through any of them.
          </DialogDescription>
          <ToolSearch value={query} onChange={setQuery} className="mt-4" />
        </DialogHeader>

        <div className="focus-safe-scroll min-h-0 overflow-y-auto p-6 pt-4">
          <ToolCatalog tools={tools} query={query} highlight={highlight} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
