import * as React from "react";
import { ShieldAlert } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CAPABILITY_META } from "@/lib/capabilities";
import { MCP_TOOLS, MCP_TOOL_GROUPS } from "@/lib/mcp/tools";
import type { Capability } from "@/lib/types";

/**
 * What an agent can actually do, and what each one costs in Capabilities.
 *
 * Read straight off the same table `/api/mcp` serves, so the page cannot drift
 * from the tools — the question this answers ("what am I handing over?") is
 * worth nothing if the answer is a copy someone forgot to update.
 *
 * A server component: it is a static read of a module constant, so there is
 * nothing here to hydrate.
 */
export function ToolTable() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">
          Tools ({MCP_TOOLS.length})
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          An agent only sees the tools its token can use. Secrets are never
          readable through any of them.
        </p>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tool</TableHead>
              <TableHead>What it does</TableHead>
              <TableHead className="w-56">Requires</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {MCP_TOOL_GROUPS.map((group) => (
              <React.Fragment key={group}>
                <TableRow className="hover:bg-transparent">
                  <TableCell
                    colSpan={3}
                    className="bg-secondary/40 text-xs font-medium uppercase tracking-wide text-muted-foreground"
                  >
                    {group}
                  </TableCell>
                </TableRow>
                {MCP_TOOLS.filter((t) => t.group === group).map((t) => (
                  <TableRow key={t.name}>
                    <TableCell className="align-top font-mono text-xs">
                      <span className="flex items-center gap-1.5">
                        {t.name}
                        {t.destructive && (
                          <ShieldAlert className="size-3.5 text-[var(--warning)]" />
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="align-top text-sm text-muted-foreground">
                      {t.description}
                    </TableCell>
                    <TableCell className="align-top">
                      {t.requires === null ? (
                        <span className="text-xs text-muted-foreground">
                          Any token
                        </span>
                      ) : t.requires === "instanceAdmin" ? (
                        <Badge variant="outline">Instance admin</Badge>
                      ) : (
                        <span className="text-xs">
                          {CAPABILITY_META[t.requires as Capability]?.label ??
                            t.requires}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </React.Fragment>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
