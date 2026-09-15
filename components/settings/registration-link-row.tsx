"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Check, Clock, Copy, LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RevealChip } from "@/components/shared/reveal-chip";
import { copyText } from "@/lib/clipboard";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { RegistrationLinkDTO } from "@/lib/data/members/registration-links";

const REVEAL = /* GraphQL */ `
  mutation ($id: String!) {
    revealRegistrationLink(id: $id)
  }
`;

export function RegistrationLinkRow({
  link,
  onRemoved,
  onRestored,
}: {
  link: RegistrationLinkDTO;
  onRemoved?: () => void;
  onRestored?: () => void;
}) {
  const router = useRouter();
  const [revealed, setRevealed] = React.useState(false);
  const [value, setValue] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [revoking, startRevoke] = React.useTransition();

  const left = useTimeLeft(link.expiresAt);
  const expired = left != null && left.ms <= 0;
  const canReveal = link.canReveal && !expired;

  const resolve = React.useCallback(async () => {
    if (value !== null) return value;
    setPending(true);
    const res = await gqlAction<{ revealRegistrationLink: string }, string>(
      REVEAL,
      { id: link.id },
      (d) => d.revealRegistrationLink,
    );
    setPending(false);
    if (!res.ok) {
      toast.error(res.error);
      return null;
    }
    setValue(res.data ?? null);
    return res.data ?? null;
  }, [link.id, value]);

  function toggle() {
    if (revealed) {
      setRevealed(false);
      return;
    }
    void resolve().then((v) => {
      if (v !== null) setRevealed(true);
    });
  }

  async function copy() {
    const v = await resolve();
    if (v === null) return;
    if (!(await copyText(v))) return;
    toast.success("Registration link copied");
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  function revoke() {
    onRemoved?.();
    startRevoke(async () => {
      const res = await gqlAction(
        `mutation ($id: String!) { revokeRegistrationLink(id: $id) }`,
        { id: link.id },
      );
      if (res.ok) toast.success("Link revoked");
      else {
        onRestored?.();
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  const scope =
    link.mode === "existing_teams"
      ? link.teamNames.length > 0
        ? `joins ${link.teamNames.join(", ")}`
        : "joins pre-assigned teams"
      : "creates their own team";

  return (
    <div
      className={cn(
        "rounded-lg border p-3",
        expired ? "border-destructive/30 bg-destructive-wash" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            expired ? "bg-destructive-wash-strong" : "bg-muted",
          )}
        >
          <LinkIcon
            className={cn(
              "size-4",
              expired ? "text-destructive" : "text-muted-foreground",
            )}
          />
        </div>

        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">Registration link</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                Created by {link.createdBy} · {scope}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {canReveal && (
                <SimpleTooltip content="Copy the link without showing it">
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={copy}
                    disabled={pending}
                    aria-label="Copy registration link"
                  >
                    {copied ? (
                      <Check className="size-4 text-emerald-500" />
                    ) : pending ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Copy className="size-4" />
                    )}
                  </Button>
                </SimpleTooltip>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={revoke}
                disabled={revoking}
              >
                Revoke
              </Button>
            </div>
          </div>

          <RevealChip
            value={value}
            revealed={revealed}
            onToggle={canReveal ? toggle : undefined}
            pending={pending}
            placeholder={link.linkMasked}
            locked={!canReveal}
            lockedHint={
              expired
                ? "This link has expired. Revoke it and mint a new one."
                : "This link was minted before links could be shown again. Revoke it and mint a new one."
            }
            labels={{
              reveal: "Reveal registration link",
              hide: "Hide registration link",
            }}
          />

          <Expiry expiresAt={link.expiresAt} left={left} />
        </div>
      </div>
    </div>
  );
}

function Expiry({
  expiresAt,
  left,
}: {
  expiresAt: string;
  left: TimeLeft | null;
}) {
  if (!left) return <p className="h-4" />;
  const expired = left.ms <= 0;
  return (
    <p
      className={cn(
        "flex items-center gap-1.5 text-xs",
        expired
          ? "text-destructive"
          : left.ms < 60 * 60_000
            ? "text-amber-600 dark:text-amber-400"
            : "text-muted-foreground",
      )}
    >
      <Clock className="size-3 shrink-0" aria-hidden />
      {expired ? (
        <>Expired {timeAgo(expiresAt)} - mint a new link</>
      ) : (
        <>
          Expires in{" "}
          <span className="font-medium tabular-nums">{left.label}</span> ·{" "}
          {atClock(expiresAt)}
        </>
      )}
    </p>
  );
}

interface TimeLeft {
  ms: number;
  label: string;
}

function useTimeLeft(expiresAt: string): TimeLeft | null {
  const [left, setLeft] = React.useState<TimeLeft | null>(null);

  React.useEffect(() => {
    const target = Date.parse(expiresAt);
    const tick = () => {
      const ms = target - Date.now();
      setLeft({ ms, label: formatLeft(ms) });
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  return left;
}

function formatLeft(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}

export function atClock(iso: string): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const day = date.toLocaleDateString([], { day: "numeric", month: "short" });
  const midnight = new Date();
  midnight.setHours(24, 0, 0, 0);
  const dayAfter = new Date(midnight);
  dayAfter.setDate(dayAfter.getDate() + 1);
  const label =
    date < midnight ? "today, " : date < dayAfter ? "tomorrow, " : "";
  return `${label}${day} at ${time}`;
}
