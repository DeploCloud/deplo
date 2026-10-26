"use client";

import * as React from "react";
import { ExternalLink } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { GITHUB_URL } from "@/lib/links";
import { cn } from "@/lib/utils";
import { DEPLO_COMMIT, DEPLO_VERSION } from "@/lib/version";

export function AboutDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const ref = DEPLO_COMMIT || "main";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>About Deplo</DialogTitle>
          <DialogDescription>
            Deplo is <strong>open source</strong>, and so is the software it is
            built on.
          </DialogDescription>
        </DialogHeader>
        <dl className="grid grid-cols-2 gap-4">
          <Row label="Version">
            <span className="font-mono">v{DEPLO_VERSION}</span>
          </Row>
          <Row label="Commit">
            {DEPLO_COMMIT ? (
              <Out
                href={`${GITHUB_URL}/commit/${DEPLO_COMMIT}`}
                label={DEPLO_COMMIT.slice(0, 7)}
                mono
              />
            ) : (
              <span className="text-muted-foreground">Unknown</span>
            )}
          </Row>
          <Row label="License">
            <Out href={`${GITHUB_URL}/blob/${ref}/LICENSE`} label="AGPL-3.0" />
          </Row>
          <Row label="Source code">
            <Out href={`${GITHUB_URL}/tree/${ref}`} label="GitHub" />
          </Row>
          <Row label="Open source licenses">
            <Out href="/third-party-notices.txt" label="Third-party notices" />
          </Row>
        </dl>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

function Out({
  href,
  label,
  mono,
}: {
  href: string;
  label: string;
  mono?: boolean;
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 hover:text-muted-foreground",
        mono && "font-mono",
      )}
    >
      {label}
      <ExternalLink className="size-3.5 text-muted-foreground" />
    </a>
  );
}
