"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Check, Clock, Copy, LinkIcon, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { RevealChip } from "@/components/shared/reveal-chip";
import { gqlAction } from "@/lib/graphql-client";
import { cn, timeAgo } from "@/lib/utils";
import type { RegistrationLinkDTO } from "@/lib/data/members";

const REVEAL = /* GraphQL */ `
  mutation ($id: String!) {
    revealRegistrationLink(id: $id)
  }
`;

/**
 * One pending registration link: what it is, when it dies, and the link itself —
 * coverable, copyable, as many times as the admin needs within its 24 hours.
 *
 * The link is a credential (whoever holds it gets an account), so it is NOT in
 * the page's HTML: the row carries only the masked form and fetches the real URL
 * through the instance-admin `revealRegistrationLink` when asked. Copying
 * resolves it the same way, which means it can go on the clipboard without ever
 * going on screen — the friendlier move while screen-sharing.
 *
 * The countdown is the point of the row, not decoration: a link that expires in
 * forty minutes is a different thing to hand someone than one that expires
 * tomorrow, and "expires in 24 hours" printed once at mint time stops being true
 * the moment the dialog closes.
 */
export function RegistrationLinkRow({ link }: { link: RegistrationLinkDTO }) {
  const router = useRouter();
  const [revealed, setRevealed] = React.useState(false);
  const [value, setValue] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [revoking, startRevoke] = React.useTransition();

  const left = useTimeLeft(link.expiresAt);
  // Live truth, not the server's snapshot: a row that was pending when the page
  // rendered goes dead while it sits on screen, and the affordances have to go
  // with it.
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
      // The server's message says which of "used / revoked / expired / too old"
      // it is — all four are things the admin needs to hear verbatim.
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

  function copy() {
    void resolve().then((v) => {
      if (v === null) return;
      navigator.clipboard.writeText(v);
      toast.success("Registration link copied");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function revoke() {
    startRevoke(async () => {
      const res = await gqlAction(
        `mutation ($id: String!) { revokeRegistrationLink(id: $id) }`,
        { id: link.id },
      );
      if (res.ok) {
        toast.success("Link revoked");
        router.refresh();
      } else {
        toast.error(res.error);
      }
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
        expired ? "border-destructive/30 bg-destructive/[0.03]" : "border-border",
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            expired ? "bg-destructive/10" : "bg-muted",
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
              <p className="truncate text-xs text-muted-foreground">
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
            // Not just inert — padlocked, with the reason. A chip that simply
            // doesn't open leaves the admin clicking at it.
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

/** The live line: how long is left, and the wall-clock moment it dies. */
function Expiry({
  expiresAt,
  left,
}: {
  expiresAt: string;
  left: TimeLeft | null;
}) {
  // Nothing until the clock is mounted: both halves of this line depend on the
  // reader's clock and locale, and a server-rendered guess would only differ
  // from what the browser then paints (a hydration mismatch on every row).
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
        <>Expired {timeAgo(expiresAt)} — mint a new link</>
      ) : (
        <>
          Expires in <span className="font-medium tabular-nums">{left.label}</span>{" "}
          · {atClock(expiresAt)}
        </>
      )}
    </p>
  );
}

interface TimeLeft {
  ms: number;
  /** `23h 59m 12s` — the seconds are there so the clock visibly runs. */
  label: string;
}

/**
 * Time left, ticking every second. A once-a-minute counter next to "expires in
 * 24 hours" is indistinguishable from a static string; the seconds are what say
 * "this is running out while you read it".
 *
 * Null until mounted, so the server never renders a clock the client disagrees
 * with a moment later (a hydration mismatch on every row).
 */
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

/**
 * "today, 22 Jul at 20:15" / "tomorrow, 23 Jul at 09:12" — the day in words
 * because that is how the operator thinks about it, and the date beside it
 * because that is what they will write down. A link never lives past tomorrow,
 * but the third branch keeps this honest if the TTL ever changes.
 */
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
