"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";

export interface NameClash {
  name: string;
  owner: string;
  renamedTo: string;
}

/**
 * A stack about to land on a network where a neighbour already answers to one of
 * its service names. Rename them here, or cancel and edit the stack by hand.
 */
export function NameClashDialog({
  clashes,
  open,
  onOpenChange,
  onRename,
  pending,
}: {
  clashes: NameClash[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: () => void;
  pending: boolean;
}) {
  const owners = [...new Set(clashes.map((c) => c.owner))];
  return (
    <Dialog open={open} onOpenChange={(o) => !pending && onOpenChange(o)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Names already in use</DialogTitle>
          <DialogDescription>
            <strong>{owners.join(", ")}</strong> already answers to these names
            here, and one network cannot answer to a name twice.
          </DialogDescription>
        </DialogHeader>
        <ul className="divide-y divide-border rounded-lg border border-border text-sm">
          {clashes.map((c) => (
            <li
              key={c.name}
              className="flex items-center justify-between gap-3 px-3 py-2"
            >
              <code className="font-mono">{c.name}</code>
              <span className="text-xs text-muted-foreground">becomes</span>
              <code className="font-mono text-foreground">{c.renamedTo}</code>
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          Everything in the stack that used a renamed service follows it. Prefer
          your own names? Cancel and edit the stack under Advanced.{" "}
          <DocsLink topic="network.isolation" />
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={onRename}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Rename and deploy
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
