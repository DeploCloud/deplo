"use client";

import * as React from "react";
import {
  Info,
  LifeBuoy,
  Loader2,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";
import { cn } from "@/lib/utils";

/**
 * The confirm in front of every move of the panel's own address. So the dialog
 * states facts, counted live, and shows ONLY the lines that are true right now - a
 * line that would read "0 passkeys" is not shown at all.
 */

type Impact = {
  url: string;
  currentUrl: string;
  hostChanges: boolean;
  schemeChanges: boolean;
  losesHttps: boolean;
  panelFallbackUrl: string | null;
  passkeys: number;
  passkeyPeople: number;
  sessions: number;
  sessionPeople: number;
  deployHooks: number;
  mcpConnections: number;
  registrationLinks: number;
  pendingServers: number;
  pushSubscriptions: number;
};

export type ImpactSeverity = "critical" | "manual" | "minor";

/** A consequence only the caller can vouch for, e.g. the proxy restarting. */
export type ImpactNote = { severity: ImpactSeverity; text: string };

type Row = ImpactNote & { weight: number };

const TIERS = [
  {
    severity: "critical",
    label: "Critical",
    icon: OctagonAlert,
    tone: "text-destructive",
    box: "border-destructive/40 bg-destructive/5",
    dot: "bg-destructive",
    body: "",
  },
  {
    severity: "manual",
    label: "Fix by hand",
    icon: TriangleAlert,
    tone: "text-warning",
    box: "border-warning/40 bg-warning/5",
    dot: "bg-warning",
    body: "",
  },
  {
    severity: "minor",
    label: "Minor",
    icon: Info,
    tone: "text-muted-foreground",
    box: "border-border bg-muted/30",
    dot: "bg-muted-foreground/60",
    body: "text-muted-foreground",
  },
] as const;

const IMPACT_QUERY = /* GraphQL */ `
  query PanelAddressImpact($url: String!) {
    panelAddressImpact(url: $url) {
      url
      currentUrl
      hostChanges
      schemeChanges
      losesHttps
      panelFallbackUrl
      passkeys
      passkeyPeople
      sessions
      sessionPeople
      deployHooks
      mcpConnections
      registrationLinks
      pendingServers
      pushSubscriptions
    }
  }
`;

const plural = (n: number, one: string, many = `${one}s`) =>
  n === 1 ? one : many;

export function PanelAddressDialog({
  open,
  onOpenChange,
  url,
  title,
  confirmLabel,
  notes,
  successMessage,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The address being moved to, as the operator typed it. */
  url: string;
  title: string;
  confirmLabel: string;
  /** Extra rows only the caller knows about, graded like the counted ones. */
  notes?: ImpactNote[];
  successMessage?: string;
  onConfirm: () => Promise<ActionResult<unknown>>;
}) {
  const [impact, setImpact] = React.useState<Impact | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);
  const [pending, startTransition] = React.useTransition();

  // Read on mount.
  React.useEffect(() => {
    let cancelled = false;
    void gqlAction<{ panelAddressImpact: Impact }, Impact>(
      IMPACT_QUERY,
      { url },
      (d) => d.panelAddressImpact,
    ).then((res) => {
      if (cancelled) return;
      if (res.ok && res.data) setImpact(res.data);
      else if (!res.ok) setFailed(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [url]);

  const loading = !impact && !failed;
  const unchanged = !!impact && !impact.hostChanges && !impact.schemeChanges;
  const rows = React.useMemo(
    () =>
      [
        ...(impact ? countedRows(impact) : []),
        ...(notes ?? []).map(asRow),
      ].sort(
        (a, b) =>
          tierIndex(a.severity) - tierIndex(b.severity) || b.weight - a.weight,
      ),
    [impact, notes],
  );

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    // Portalled out of any ancestor form in the DOM, but React still bubbles
    // the submit up the React tree - so without this an outer form (the
    // address field's own) would silently submit too.
    e.stopPropagation();
    // Nothing to agree to until the counts land: confirming before then would
    // be agreeing to an unknown.
    if (pending || loading) return;
    startTransition(async () => {
      const res = await onConfirm();
      if (res.ok) {
        if (successMessage) toast.success(successMessage);
        onOpenChange(false);
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/**
       * Wider than the house confirm on purpose: this one opens on an audit, not a
       * sentence, and three graded cards need room to breathe.
       */}
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-xl">
        <form className="grid grid-cols-[minmax(0,1fr)]" onSubmit={onSubmit}>
          <div className="flex justify-center border-b border-border bg-muted/30 px-6 pt-7 pb-5">
            <PanelMoveGraphic />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)] gap-5 p-6">
            <DialogHeader className="space-y-2">
              <DialogTitle>{title}</DialogTitle>
              {/* The counts ARE the summary: how many things break, graded.
                  Every other sentence that could go here is one the cards below
                  repeat. */}
              <DialogDescription className="leading-relaxed">
                {unchanged
                  ? "This is the address the panel already answers on, so nothing changes."
                  : rows.length > 0
                    ? summarise(rows)
                    : "Everything tied to the old address stops working there."}
              </DialogDescription>
            </DialogHeader>

            {loading && (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-border py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Checking what this would break
              </div>
            )}

            {/* The move is still allowed: the counts are information, and
                refusing to move an address because a probe failed would take
                away the very recovery this page is for. */}
            {failed && (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
                {failed}
              </p>
            )}

            {TIERS.map((tier) => {
              const group = rows.filter((r) => r.severity === tier.severity);
              if (group.length === 0) return null;
              const Icon = tier.icon;
              return (
                <section
                  key={tier.severity}
                  className={cn("rounded-lg border p-4", tier.box)}
                >
                  {/* The icon grades the GROUP once, up in the heading, instead
                      of stamping every sentence: rows keep a quiet dot and the
                      severity stays legible at a glance. */}
                  <p
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-semibold tracking-wide uppercase",
                      tier.tone,
                    )}
                  >
                    <Icon className="size-3.5" />
                    {tier.label}
                  </p>
                  <ul className="mt-3 space-y-2.5">
                    {group.map((row) => (
                      <li
                        key={row.text}
                        className={cn(
                          "flex items-start gap-2.5 text-sm leading-relaxed",
                          tier.body,
                        )}
                      >
                        <span
                          className={cn(
                            "mt-[0.55em] size-1.5 shrink-0 rounded-full",
                            tier.dot,
                          )}
                        />
                        <span>{row.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              );
            })}

            {impact && !unchanged && rows.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Nothing on this instance is tied to the old address yet.
              </p>
            )}

            {/* Last line, always: the one address this change cannot break. */}
            {impact?.panelFallbackUrl && (
              <p className="flex items-start gap-2.5 rounded-lg bg-muted/40 p-3 text-sm text-muted-foreground">
                <LifeBuoy className="mt-0.5 size-4 shrink-0" />
                <span>
                  You can always get back in at{" "}
                  <span className="font-mono break-all text-foreground">
                    {impact.panelFallbackUrl}
                  </span>
                </span>
              </p>
            )}

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="destructive"
                disabled={pending || loading}
                aria-busy={pending}
                aria-label={pending ? confirmLabel : undefined}
              >
                {/* While the action runs, a spinner stands in for the label.
                    The label stays mounted (just hidden) so the button keeps
                    its width and the footer doesn't jump mid-action. */}
                <span className="grid place-items-center">
                  <span
                    className={cn(
                      "col-start-1 row-start-1",
                      pending && "invisible",
                    )}
                  >
                    {confirmLabel}
                  </span>
                  {pending && (
                    <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
                  )}
                </span>
              </Button>
            </DialogFooter>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The move, drawn: traffic leaves the window on the old address, crosses the wire,
 * and the window on the new address answers with a ring.
 */
function PanelMoveGraphic() {
  return (
    <svg
      viewBox="0 0 240 112"
      fill="none"
      role="img"
      aria-label="The panel moving from its old address to its new one"
      className="h-24 w-auto max-w-full sm:h-28"
    >
      {/* The old address: the same window, already dimmed to what it is about
          to become - somewhere traffic leaves. */}
      <g>
        <rect
          x="16"
          y="30"
          width="72"
          height="52"
          rx="8"
          className="stroke-muted-foreground/50"
          strokeWidth="2"
        />
        <line
          x1="16"
          y1="46"
          x2="88"
          y2="46"
          className="stroke-muted-foreground/30"
          strokeWidth="1.5"
        />
        <circle cx="25" cy="38" r="2.25" className="fill-muted-foreground/40" />
        <circle
          cx="32.5"
          cy="38"
          r="2.25"
          className="fill-muted-foreground/40"
        />
        <circle cx="40" cy="38" r="2.25" className="fill-muted-foreground/40" />
        <rect
          x="48"
          y="34"
          width="32"
          height="8"
          rx="4"
          className="fill-muted-foreground/25"
        />
        <line
          x1="26"
          y1="58"
          x2="70"
          y2="58"
          className="stroke-muted-foreground/25"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <line
          x1="26"
          y1="68"
          x2="58"
          y2="68"
          className="stroke-muted-foreground/25"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>

      {/* The wire. Its dashes drift towards the new address on their own short
          clock - ambient, because the link exists whether or not a packet is
          in flight. */}
      <path
        d="M94 56 H146"
        className="deplo-move-wire stroke-muted-foreground/50"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <circle
        cx="94"
        cy="56"
        r="4"
        className="deplo-move-packet fill-primary"
      />

      {/* The ring is drawn BEFORE the new window so it lands behind its
          strokes: an answer radiating from the address, not a lasso around
          it. */}
      <circle
        cx="188"
        cy="56"
        r="42"
        className="deplo-move-ring stroke-primary"
        strokeWidth="1.5"
      />

      {/* The new address: the same window at full strength, address bar lit -
          the one element in the drawing that is already certain. */}
      <g>
        <rect
          x="152"
          y="30"
          width="72"
          height="52"
          rx="8"
          className="stroke-primary"
          strokeWidth="2"
        />
        <line
          x1="152"
          y1="46"
          x2="224"
          y2="46"
          className="stroke-primary/30"
          strokeWidth="1.5"
        />
        <circle cx="161" cy="38" r="2.25" className="fill-primary/50" />
        <circle cx="168.5" cy="38" r="2.25" className="fill-primary/50" />
        <circle cx="176" cy="38" r="2.25" className="fill-primary/50" />
        <rect
          x="184"
          y="34"
          width="32"
          height="8"
          rx="4"
          className="fill-primary"
        />
        <line
          x1="162"
          y1="58"
          x2="206"
          y2="58"
          className="stroke-primary/25"
          strokeWidth="3"
          strokeLinecap="round"
        />
        <line
          x1="162"
          y1="68"
          x2="194"
          y2="68"
          className="stroke-primary/25"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </g>
    </svg>
  );
}

const tierIndex = (s: ImpactSeverity) =>
  TIERS.findIndex((t) => t.severity === s);

/** A caller's row sorts last inside its group: it carries no head count. */
const asRow = (note: ImpactNote): Row => ({ ...note, weight: 0 });

function summarise(rows: Row[]): string {
  return TIERS.map((tier) => {
    const n = rows.filter((r) => r.severity === tier.severity).length;
    return n === 0
      ? null
      : tier.severity === "critical"
        ? `${n} critical`
        : tier.severity === "manual"
          ? `${n} to fix by hand`
          : `${n} minor`;
  })
    .filter(Boolean)
    .join(" · ");
}

function countedRows(impact: Impact): Row[] {
  // Whatever a browser welded to the origin dies on a hostname change and on
  // losing https; on http -> https the session survives (Deplo hands Better Auth
  // both cookie names) and there were no passkeys to lose.
  const originDies = impact.hostChanges || impact.losesHttps;
  const rows: Row[] = [];

  if (originDies && impact.passkeys > 0)
    rows.push({
      severity: "critical",
      weight: impact.passkeyPeople,
      text: `${impact.passkeys} ${plural(impact.passkeys, "passkey")} on ${impact.passkeyPeople} ${plural(impact.passkeyPeople, "account")} stop working - everyone registers a new one`,
    });

  if (impact.losesHttps)
    rows.push({
      severity: "critical",
      weight: 0,
      text: "Browsers that loaded this panel over https will refuse plain http here for months",
    });

  if (impact.deployHooks > 0)
    rows.push({
      severity: "manual",
      weight: impact.deployHooks,
      text: `${impact.deployHooks} deploy ${plural(impact.deployHooks, "hook")} keep the old address - re-copy each URL from the app's settings`,
    });

  if (impact.registrationLinks > 0)
    rows.push({
      severity: "manual",
      weight: impact.registrationLinks,
      text: `${impact.registrationLinks} invite ${plural(impact.registrationLinks, "link")} point at the old address - copy and send them again`,
    });

  if (impact.pushSubscriptions > 0)
    rows.push({
      severity: "manual",
      weight: impact.pushSubscriptions,
      text: `${impact.pushSubscriptions} notification ${plural(impact.pushSubscriptions, "subscription")} stop - each person turns them back on`,
    });

  if (impact.mcpConnections > 0)
    rows.push({
      severity: "manual",
      weight: impact.mcpConnections,
      text: `${impact.mcpConnections} connected AI ${plural(impact.mcpConnections, "client")} must reconnect`,
    });

  if (impact.pendingServers > 0)
    rows.push({
      severity: "manual",
      weight: impact.pendingServers,
      text: `${impact.pendingServers} ${plural(impact.pendingServers, "server")} still waiting for the install command - generate it again`,
    });

  if (originDies && impact.sessions > 0)
    rows.push({
      severity: "minor",
      weight: impact.sessionPeople,
      text: `${impact.sessions} ${plural(impact.sessions, "sign-in")} across ${impact.sessionPeople} ${plural(impact.sessionPeople, "account")} end - everyone signs in again, you included`,
    });

  return rows;
}
