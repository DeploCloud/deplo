"use client";

import * as React from "react";
import { AlertTriangle, LifeBuoy, Loader2 } from "lucide-react";

import { ConfirmAction } from "@/components/shared/confirm-action";
import { gqlAction } from "@/lib/graphql-client";
import type { ActionResult } from "@/lib/result";

/**
 * The confirm in front of every move of the panel's own address.
 *
 * Changing this address is the most destructive thing on the page and the only
 * one that looks harmless: it is a text field. A browser welds credentials,
 * cookies and subscriptions to the exact origin they were made on, so the move
 * takes every passkey on the instance with it, silently and for good, and
 * freezes every URL Deplo has ever handed out. None of that is visible from the
 * field.
 *
 * So the dialog states facts, counted live, and shows ONLY the lines that are
 * true right now - the shape `DeleteUserDialog` set. Two groups, because the
 * difference is what the reader needs: what is GONE (red) and what has to be
 * done again (muted). A line that would read "0 passkeys" is not shown at all.
 *
 * Used by the address field AND by the HTTPS switch: turning https off is the
 * same destruction by another door - WebAuthn has no relying party on plain
 * http - and it used to say nothing about it.
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
  gitConnections: number;
  githubApps: number;
};

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
      gitConnections
      githubApps
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
  note,
  successMessage,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  /** The address being moved to, as the operator typed it. */
  url: string;
  title: string;
  confirmLabel: string;
  /** A consequence only the caller can vouch for, e.g. the proxy restarting. */
  note?: string;
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

  return (
    <ConfirmAction
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={
        impact && !impact.hostChanges && !impact.schemeChanges
          ? "This is the address the panel already answers on, so nothing changes."
          : "Everything a browser tied to the old address stops working there, and every address Deplo has handed out changes."
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
          {impact && <ImpactRows impact={impact} />}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
      }
      onConfirm={onConfirm}
    />
  );
}

function ImpactRows({ impact }: { impact: Impact }) {
  // Whatever a browser welded to the origin dies on a hostname change and on
  // losing https; on http -> https the session survives (Deplo hands Better Auth
  // both cookie names) and there were no passkeys to lose.
  const originDies = impact.hostChanges || impact.losesHttps;
  const lost: React.ReactNode[] = [];
  const redo: React.ReactNode[] = [];

  if (originDies && impact.passkeys > 0)
    lost.push(
      <Line
        key="passkeys"
        title={`${impact.passkeys} ${plural(impact.passkeys, "passkey")} on ${impact.passkeyPeople} ${plural(impact.passkeyPeople, "account")} stop working`}
        detail="A passkey belongs to one address and cannot be moved. Everyone registers a new one, and anyone whose team requires two-factor is asked for a new second factor before they can do anything."
      />,
    );

  if (impact.losesHttps)
    lost.push(
      <Line
        key="hsts"
        title="Browsers that loaded this panel over https will refuse plain http on it"
        detail="They remember the instruction for months and nothing here can take it back. The IP address below is not affected."
      />,
    );

  if (originDies && impact.sessions > 0)
    redo.push(
      <Line
        key="sessions"
        muted
        title={`${impact.sessions} ${plural(impact.sessions, "sign-in")} across ${impact.sessionPeople} ${plural(impact.sessionPeople, "account")} end`}
        detail="Everyone signs in again at the new address, you included."
      />,
    );

  if (impact.deployHooks > 0)
    redo.push(
      <Line
        key="hooks"
        muted
        title={`${impact.deployHooks} deploy ${plural(impact.deployHooks, "hook")} keep pointing at the old address`}
        detail="Copy the new URL from each app's settings into whatever calls it."
      />,
    );

  if (impact.mcpConnections > 0)
    redo.push(
      <Line
        key="mcp"
        muted
        title={`${impact.mcpConnections} connected AI ${plural(impact.mcpConnections, "client")} must reconnect`}
        detail="Their connection is issued for the old address."
      />,
    );

  if (impact.pushSubscriptions > 0)
    redo.push(
      <Line
        key="push"
        muted
        title={`${impact.pushSubscriptions} browser notification ${plural(impact.pushSubscriptions, "subscription")} stop`}
        detail="Each person turns notifications back on at the new address."
      />,
    );

  if (impact.registrationLinks > 0)
    redo.push(
      <Line
        key="links"
        muted
        title={`${impact.registrationLinks} invite ${plural(impact.registrationLinks, "link")} point at the old address`}
        detail="Copy each one again on Settings, Users and re-send it. The links themselves stay valid."
      />,
    );

  if (impact.pendingServers > 0)
    redo.push(
      <Line
        key="servers"
        muted
        title={`${impact.pendingServers} ${plural(impact.pendingServers, "server")} still waiting for the install command`}
        detail="Generate it again from the server's page so it points here."
      />,
    );

  if (impact.gitConnections > 0 || impact.githubApps > 0)
    redo.push(
      <Line
        key="git"
        muted
        title="Git webhooks and the GitHub App are not moved by this"
        detail="They point at the address this instance was installed with, and go on working exactly as they do now."
      />,
    );

  if (lost.length === 0 && redo.length === 0)
    return (
      <p className="text-sm text-muted-foreground">
        Nothing on this instance is tied to the old address yet.
      </p>
    );

  return (
    <>
      {lost.length > 0 && (
        <div className="space-y-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          {lost}
        </div>
      )}
      {redo.length > 0 && <div className="space-y-2">{redo}</div>}
      {impact.panelIpUrl && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
          <LifeBuoy className="mt-0.5 size-3.5 shrink-0" />
          You can always get back in at{" "}
          <span className="font-mono break-all">{impact.panelIpUrl}</span>
        </p>
      )}
    </>
  );
}

function Line({
  title,
  detail,
  muted = false,
}: {
  title: string;
  detail: string;
  muted?: boolean;
}) {
  return (
    <div>
      <p
        className={
          muted
            ? "font-medium"
            : "flex items-start gap-1.5 font-medium text-destructive"
        }
      >
        {!muted && <AlertTriangle className="mt-0.5 size-4 shrink-0" />}
        {title}
      </p>
      <p className="mt-1 text-xs text-muted-foreground">{detail}</p>
    </div>
  );
}
