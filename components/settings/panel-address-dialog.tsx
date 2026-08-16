"use client";

import * as React from "react";
import {
  Info,
  LifeBuoy,
  Loader2,
  OctagonAlert,
  TriangleAlert,
} from "lucide-react";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";
import { cn } from "@/lib/utils";

/**
 * The confirm in front of every move of the panel's own address.
 *
 * Changing this address is the most destructive thing on the page and the only
 * one that looks harmless: it is a text field. A browser welds credentials,
 * cookies and subscriptions to the exact origin they were made on, so the move
 * takes every passkey on the instance with it, and freezes every URL Deplo has
 * ever handed out. None of that is visible from the field.
 *
 * So the dialog states facts, counted live, and shows ONLY the lines that are
 * true right now - a line that would read "0 passkeys" is not shown at all.
 * Each one is a single sentence with an icon: what breaks, and what fixes it
 * when that is not obvious. No second paragraph, ever - the reader is deciding,
 * not studying.
 *
 * The three groups are the whole point, and the split is by ONE objective test:
 * **what it takes to get the thing working again.**
 *
 *  - **Critical** - Deplo cannot give it back. A passkey is bound to the origin
 *    it was made on, the HSTS a browser remembers is not ours to clear, and a
 *    password already sent in the clear cannot be un-sent.
 *  - **Fix by hand** - it stays broken until a person goes somewhere and
 *    re-copies something. Deplo knows the new value and still cannot deliver
 *    it: the old one is pasted in someone else's CI, in a sent invite, in an
 *    AI client's config.
 *  - **Minor** - it repairs itself the next time it is used. Ending every
 *    session sounds like the scariest line here and is the cheapest one: people
 *    sign in again.
 *
 * That ordering is why the severity is worth computing rather than asserting -
 * it demotes the loud, harmless line and promotes the quiet, permanent one.
 * Within a group, rows are ordered by how many people they hit.
 *
 * Used by the address field AND by the HTTPS switch: turning https off is the
 * same destruction by another door - WebAuthn has no relying party on plain
 * http - so that caller adds its own rows through `notes` instead of a
 * paragraph outside the list.
 */

type Impact = {
  url: string;
  currentUrl: string;
  hostChanges: boolean;
  schemeChanges: boolean;
  losesHttps: boolean;
  panelIpUrl: string | null;
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
    box: "rounded-lg border border-destructive/40 bg-destructive/5 p-3",
    body: "",
  },
  {
    severity: "manual",
    label: "Fix by hand",
    icon: TriangleAlert,
    tone: "text-[var(--warning)]",
    box: "",
    body: "",
  },
  {
    severity: "minor",
    label: "Minor",
    icon: Info,
    tone: "text-muted-foreground",
    box: "",
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
      panelIpUrl
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

  // Read on mount. The caller mounts this dialog only while it is open and
  // unmounts it on close (the repo's dialog idiom), so the counts are never
  // stale across two openings and there is nothing to clear here first - an
  // address moves between one look and the next, and a stale preview is exactly
  // the surprise this dialog exists to prevent.
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

  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      // The counts ARE the summary: how many things break, graded. Every other
      // sentence that could go here is one the list below repeats.
      description={
        unchanged
          ? "This is the address the panel already answers on, so nothing changes."
          : rows.length > 0
            ? summarise(rows)
            : "Everything tied to the old address stops working there."
      }
      confirmLabel={confirmLabel}
      successMessage={successMessage}
      variant="destructive"
      // Nothing to agree to until the counts land: confirming before then would
      // be agreeing to an unknown.
      confirmDisabled={loading}
      extra={
        <div className="grid max-h-[45vh] gap-3 overflow-y-auto text-sm">
          {loading && (
            <div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Checking what this would break
            </div>
          )}
          {/* The move is still allowed: the counts are information, and refusing
              to move an address because a probe failed would take away the very
              recovery this page is for. */}
          {failed && (
            <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
              {failed}
            </p>
          )}
          {TIERS.map((tier) => {
            const group = rows.filter((r) => r.severity === tier.severity);
            if (group.length === 0) return null;
            const Icon = tier.icon;
            return (
              <div key={tier.severity} className={tier.box}>
                <p
                  className={cn(
                    "text-xs font-semibold tracking-wide uppercase",
                    tier.tone,
                  )}
                >
                  {tier.label}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {group.map((row) => (
                    <li key={row.text} className="flex items-start gap-2">
                      <Icon
                        className={cn("mt-0.5 size-4 shrink-0", tier.tone)}
                      />
                      <span className={tier.body}>{row.text}</span>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
          {impact && !unchanged && rows.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Nothing on this instance is tied to the old address yet.
            </p>
          )}
          {/* Last line, always: the one address this change cannot break. */}
          {impact?.panelIpUrl && (
            <p className="flex items-start gap-2 text-xs text-muted-foreground">
              <LifeBuoy className="mt-0.5 size-3.5 shrink-0" />
              <span>
                You can always get back in at{" "}
                <span className="font-mono break-all text-foreground">
                  {impact.panelIpUrl}
                </span>
              </span>
            </p>
          )}
        </div>
      }
      onConfirm={onConfirm}
    />
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
