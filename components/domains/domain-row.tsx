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
} from "lucide-react";
import { TableCell, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
} from "@/lib/actions/domains";
import type { Domain } from "@/lib/types";

type Row = Domain & { projectName: string; projectSlug: string };

export function DomainRow({ domain }: { domain: Row }) {
  const [pending, startTransition] = React.useTransition();
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  function call(fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) {
    startTransition(async () => {
      const res = await fn();
      if (res.ok) toast.success(ok);
      else toast.error(res.error);
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
      </TableCell>
    </TableRow>
  );
}
