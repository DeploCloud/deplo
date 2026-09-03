"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import {
  Cloud,
  Lock,
  RotateCw,
  ScrollText,
  Server,
  ShieldOff,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/shared/status-badge";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RecoveryKeyNudge } from "@/components/storage/recovery-key";
import {
  DestinationBar,
  spaceLabel,
  storedLabel,
} from "@/components/storage/destination-space";
import {
  firstLine,
  PROVIDER_LABEL,
  useDestinationActions,
  type DestinationCardView,
} from "@/components/storage/destination-actions";
import { cn, timeAgo } from "@/lib/utils";

export function DestinationCard({
  dest,
  canManage,
}: {
  dest: DestinationCardView;
  /** `manage_backup_destinations`. Gates testing, the recovery key and removal. */
  canManage: boolean;
}) {
  const router = useRouter();
  const { pending, test, openLog, menu, dialogs } = useDestinationActions({
    dest,
    canManage,
  });
  const isServer = dest.kind === "server";
  // What decides whether there is a key to save is the KEYPAIR, not the kind: a
  // bucket connected since bucket artifacts started being encrypted has one too.
  const encrypted = dest.encrypted;

  return (
    <>
      <Card>
        <CardContent className="space-y-4 p-5">
          <div className="flex items-start justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-border bg-secondary">
                {isServer ? (
                  <Server className="size-5" />
                ) : (
                  <Cloud className="size-5" />
                )}
              </div>
              <div className="min-w-0">
                {/* The name owns the title line: three-up there is no room for
                    it AND two chips, and a truncated name is a useless card. */}
                <p className="truncate font-medium">{dest.name}</p>
                <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                  <span className="truncate">
                    {isServer
                      ? (dest.serverName ?? "A removed server")
                      : (PROVIDER_LABEL[dest.provider ?? ""] ?? dest.provider)}
                  </span>
                  {isServer && (
                    <Badge
                      variant="info"
                      className="px-1.5 py-0 text-[10px] font-normal"
                    >
                      Beta
                    </Badge>
                  )}
                  {/**
                   * A property of the destination, so it sits with its name - not a row in the
                   * detail list, where "Encryption: Always on" read as a setting somebody chose.
                   */}
                  {encrypted && (
                    <SimpleTooltip content="Backups here are encrypted before they leave the server. Only this destination's recovery key can open them.">
                      <Badge
                        variant="muted"
                        className="px-1.5 py-0 text-[10px] font-normal"
                      >
                        <Lock className="size-3" />
                        Encrypted
                      </Badge>
                    </SimpleTooltip>
                  )}
                </p>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <StatusBadge status={dest.status} />
              {menu}
            </div>
          </div>

          {/* The proportion only: every figure behind it is a row below, so a
              three-up card is not carrying a panel. */}
          {isServer && <DestinationBar dest={dest} />}

          <dl className="grid gap-1 text-xs">
            {isServer ? (
              <>
                <Row label="Folder">
                  <span className="truncate font-mono">
                    {dest.resolvedPath ?? "Not set up yet"}
                  </span>
                </Row>
                <Row label="Space">{spaceLabel(dest)}</Row>
              </>
            ) : (
              <>
                <Row label="Bucket">
                  <span className="truncate font-mono">
                    {dest.bucket}
                    <span className="text-muted-foreground">
                      {dest.region ? ` · ${dest.region}` : ""}
                    </span>
                  </span>
                </Row>
                <Row label="Endpoint">
                  <span className="truncate font-mono">{dest.endpoint}</span>
                </Row>
              </>
            )}
            <Row label="Backups">{storedLabel(dest)}</Row>
            <Row label={isServer ? "Measured" : "Tested"}>
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate">
                  {dest.lastTestAt ? timeAgo(dest.lastTestAt) : "Never"}
                </span>
                {canManage && (
                  <SimpleTooltip content="Test this destination and measure it again">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Test connection"
                      className="-my-1 size-6"
                      disabled={pending}
                      onClick={test}
                    >
                      <RotateCw
                        className={cn("size-3", pending && "animate-spin")}
                      />
                    </Button>
                  </SimpleTooltip>
                )}
              </span>
            </Row>
            <Row label="Added">{timeAgo(dest.createdAt)}</Row>
          </dl>

          {/**
           * The UNENCRYPTED nudge, and it is deliberately the loudest thing on the card. So
           * the nudge asks for the only thing that actually fixes it, rather than offering a
           * button that would quietly re-encrypt nothing.
           */}
          {!encrypted && (
            <div className="flex w-full items-start gap-2 rounded-lg border border-[var(--warning)]/30 bg-[var(--warning)]/5 p-3 text-left">
              <ShieldOff className="mt-0.5 size-3.5 shrink-0 text-[var(--warning)]" />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block text-xs font-medium">
                  Backups here are not encrypted
                </span>
                <span className="block text-xs text-muted-foreground">
                  This destination was added before encryption, so anyone who
                  can read the bucket can read these backups. Add it again to
                  get an encrypted one, then point your schedules at it.
                </span>
              </span>
            </div>
          )}

          {/* The recovery-key nudge. These backups are encrypted, so a key kept
              only inside Deplo is a key that dies with the instance the backups
              exist to survive. Stays until someone downloads it. */}
          {encrypted && canManage && !dest.recoveryKeySavedAt && (
            <RecoveryKeyNudge
              destinationId={dest.id}
              onSaved={() => router.refresh()}
            />
          )}

          {/* Why the badge is red, right on the card. The status alone used to be
              the whole story, so a failing destination said "Error" and stopped. */}
          {dest.lastTestError && canManage && (
            <button
              type="button"
              onClick={openLog}
              className="flex w-full items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-left transition-colors hover:bg-destructive/10"
            >
              <ScrollText className="mt-0.5 size-3.5 shrink-0 text-destructive" />
              <span className="min-w-0 flex-1 space-y-0.5">
                <span className="block truncate text-xs text-destructive">
                  {firstLine(dest.lastTestError)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {dest.lastTestAt
                    ? `Last tested ${timeAgo(dest.lastTestAt)} - open the connection log`
                    : "Open the connection log"}
                </span>
              </span>
            </button>
          )}
        </CardContent>
      </Card>
      {dialogs}
    </>
  );
}

/** One `label: value` line of the card's detail list. */
function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-16 shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 truncate">{children}</dd>
    </div>
  );
}
