"use client";

import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  MoreHorizontal,
  ShieldCheck,
  Star,
  Trash2,
  ExternalLink,
  RefreshCw,
  Network,
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "@/components/shared/status-badge";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  verifyDomainAction,
  setPrimaryDomainAction,
  removeDomainAction,
  setDomainPortAction,
} from "@/lib/actions/domains";
import type { Domain } from "@/lib/types";

type Row = Domain & { projectName: string; projectSlug: string };

export function DomainRow({
  domain,
  portConfigurable = true,
}: {
  domain: Row;
  /** Whether per-domain port overrides apply to this domain's project. False
   * for compose/template stacks, which route per-service via the compose file —
   * the port control is hidden there to avoid promising a no-op. */
  portConfigurable?: boolean;
}) {
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [portOpen, setPortOpen] = React.useState(false);
  const [portValue, setPortValue] = React.useState(
    domain.port != null ? String(domain.port) : "",
  );

  function call(
    fn: () => Promise<{ ok: boolean; error?: string; data?: string }>,
    ok: string,
  ) {
    startTransition(async () => {
      const res = await fn();
      // Prefer the action's own message (it reports whether routing was applied
      // instantly or deferred to the next deploy), falling back to the caller's.
      if (res.ok) toast.success(res.data ?? ok);
      else toast.error(res.error);
    });
  }

  function savePort() {
    const trimmed = portValue.trim();
    const portNum = trimmed ? Number(trimmed) : null;
    if (trimmed && (!Number.isInteger(portNum) || portNum! < 1 || portNum! > 65535)) {
      toast.error("Port must be between 1 and 65535");
      return;
    }
    startTransition(async () => {
      const res = await setDomainPortAction({ id: domain.id, port: portNum });
      if (res.ok) {
        toast.success(res.data ?? "Port updated");
        setPortOpen(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <TableRow>
      <TableCell>
        <div className="flex items-center gap-2">
          <a
            href={`https://${domain.name}`}
            target="_blank"
            rel="noopener noreferrer"
            className="cursor-pointer font-medium hover:underline"
          >
            {domain.name}
          </a>
          {domain.primary && (
            <Badge variant="secondary" className="gap-1">
              <Star className="size-3" />
              Primary
            </Badge>
          )}
          {domain.port != null && (
            <Badge variant="outline" className="gap-1 font-mono">
              <Network className="size-3" />:{domain.port}
            </Badge>
          )}
          {domain.ssl && (
            <ShieldCheck className="size-3.5 text-[var(--success)]" />
          )}
        </div>
        {domain.redirectTo && (
          <p className="text-xs text-muted-foreground">→ {domain.redirectTo}</p>
        )}
      </TableCell>
      <TableCell>
        <Link
          href={`/projects/${domain.projectSlug}`}
          className="cursor-pointer text-sm text-muted-foreground hover:text-foreground"
        >
          {domain.projectName}
        </Link>
      </TableCell>
      <TableCell>
        <StatusBadge status={domain.status} />
      </TableCell>
      <TableCell className="text-right">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Domain menu">
              <MoreHorizontal className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem asChild>
              <a
                href={`https://${domain.name}`}
                target="_blank"
                rel="noopener noreferrer"
                className="cursor-pointer"
              >
                <ExternalLink className="size-4" />
                Visit
              </a>
            </DropdownMenuItem>
            {domain.status !== "valid" && (
              <DropdownMenuItem
                onClick={() => call(() => verifyDomainAction(domain.id), "Domain verified")}
                disabled={pending}
              >
                <RefreshCw className="size-4" />
                Verify
              </DropdownMenuItem>
            )}
            {!domain.primary && (
              <DropdownMenuItem
                onClick={() =>
                  call(() => setPrimaryDomainAction(domain.id), "Set as primary")
                }
                disabled={pending}
              >
                <Star className="size-4" />
                Set as primary
              </DropdownMenuItem>
            )}
            {portConfigurable && (
              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setPortValue(domain.port != null ? String(domain.port) : "");
                  setPortOpen(true);
                }}
              >
                <Network className="size-4" />
                {domain.port != null ? "Change port" : "Set port"}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onSelect={(e) => {
                e.preventDefault();
                setConfirmOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              Remove
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <ConfirmAction
          open={confirmOpen}
          onOpenChange={setConfirmOpen}
          title={`Remove ${domain.name}?`}
          description="The domain will stop routing to this project. You can re-add it later."
          confirmLabel="Remove domain"
          successMessage="Domain removed"
          onConfirm={() => removeDomainAction(domain.id)}
        />
        <Dialog open={portOpen} onOpenChange={setPortOpen}>
          <DialogContent className="text-left">
            <DialogHeader>
              <DialogTitle>Service port for {domain.name}</DialogTitle>
              <DialogDescription>
                The container port this domain routes to. Leave blank to use the
                project&apos;s default port. Applies instantly when the project
                is running.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={`port-${domain.id}`}>Port</Label>
              <Input
                id={`port-${domain.id}`}
                type="number"
                min={1}
                max={65535}
                value={portValue}
                onChange={(e) => setPortValue(e.target.value)}
                placeholder="Default port"
                className="font-mono text-sm"
              />
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPortOpen(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button onClick={savePort} disabled={pending}>
                {pending ? "Saving…" : "Save port"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </TableCell>
    </TableRow>
  );
}
