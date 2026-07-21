"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { gqlAction } from "@/lib/graphql-client";

/** How often the page re-checks unsettled domains' DNS. 30s is a deliberate
 * middle ground: fast enough that a freshly-created record is picked up about
 * as soon as it propagates, slow enough that a check is a rounding error (one
 * DNS resolve per domain — the server skips the routing re-apply when nothing
 * changed, so an idle check never touches the agent). */
const CHECK_INTERVAL_MS = 30_000;

/** The slice of a domain row the checker needs: identity for the mutation,
 * name for the toast, status to detect a flip. */
export interface UnsettledDomain {
  id: string;
  name: string;
  status: string;
}

/**
 * The "waiting for DNS" callout on the app's Domains page — and the automation
 * behind it. While mounted (i.e. while the page has at least one
 * pending/misconfigured domain) it re-runs the server-side DNS check for each
 * of those domains every {@link CHECK_INTERVAL_MS}: once on mount (the stored
 * status may be stale — the user often fixes DNS elsewhere and comes back),
 * then on the interval, skipping ticks while the tab is hidden. The moment a
 * check flips a domain routable, routing is applied server-side by the same
 * mutation, a toast announces it, and the RSC tree is refreshed so the row
 * turns green — the user never has to find the Verify button (it still exists
 * for an impatient immediate re-check).
 *
 * Checks reuse the `verifyDomain` mutation, which is `manage_domains`-gated —
 * a viewer's checks would fail on every tick, so after two consecutive rounds
 * where every call failed the polling stops and the callout drops its
 * "automatic" claim rather than promise something it can't do.
 */
export function DomainDnsAutoCheck({
  domains,
  serverIp,
}: {
  /** The page's unsettled (non-`valid`, non-`cloudflare`) domains — i.e. the
   * ones a further DNS check could still move. A proxied (`cloudflare`) host is
   * excluded even though it is unverified: re-resolving it can only ever return
   * Cloudflare's anycast IPs again, so polling it would spin forever without
   * ever learning anything. */
  domains: UnsettledDomain[];
  /** The public IPv4 these domains' A records must point at (this app's
   * server), shown in the callout. Absent when no usable IP is recorded. */
  serverIp?: string;
}) {
  const router = useRouter();
  const [checking, setChecking] = React.useState(false);
  const [disabled, setDisabled] = React.useState(false);

  // The poll loop reads the CURRENT props through a ref so the single mounted
  // interval survives router.refresh() prop updates without re-arming. Synced
  // in an effect (not during render — react-hooks/refs).
  const domainsRef = React.useRef(domains);
  React.useEffect(() => {
    domainsRef.current = domains;
  }, [domains]);

  React.useEffect(() => {
    let cancelled = false;
    let running = false;
    let failedRounds = 0;

    async function checkAll() {
      // Never overlap two rounds, and only check while the tab is actually
      // being looked at — a background tab just waits for the next tick.
      if (cancelled || running || document.hidden) return;
      running = true;
      setChecking(true);
      let changed = false;
      let failures = 0;
      for (const d of domainsRef.current) {
        const res = await gqlAction<{
          verifyDomain: { id: string; status: string };
        }>(
          /* GraphQL */ `mutation($id: String!) {
            verifyDomain(id: $id) { id status }
          }`,
          { id: d.id },
        );
        if (cancelled) break;
        if (!res.ok) {
          failures++;
          continue;
        }
        const status = res.data?.verifyDomain.status;
        if (status && status !== d.status) {
          changed = true;
          if (status === "valid")
            toast.success(`${d.name} verified — routing is live`);
          else if (status === "cloudflare")
            toast.warning(
              `${d.name} is proxied through Cloudflare — routed, but deplo can’t confirm it reaches this app`,
            );
        }
      }
      running = false;
      setChecking(false);
      if (cancelled) return;
      // Every call failing (twice in a row, so one transient blip doesn't
      // count) means the user can't verify domains at all — stop polling.
      if (failures > 0 && failures === domainsRef.current.length) {
        if (++failedRounds >= 2) {
          setDisabled(true);
          cancelled = true;
        }
      } else {
        failedRounds = 0;
      }
      // Refresh the RSC tree so flipped rows re-render green (and this
      // component unmounts once nothing is left to watch).
      if (changed) router.refresh();
    }

    void checkAll();
    const timer = setInterval(() => void checkAll(), CHECK_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [router]);

  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-border bg-secondary/40 px-3.5 py-2.5 text-sm">
      <RefreshCw
        className={
          checking
            ? "mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
            : "mt-0.5 size-4 shrink-0 text-muted-foreground"
        }
      />
      <div className="space-y-0.5">
        <p className="font-medium">
          {disabled ? "Waiting for DNS" : "Waiting for DNS — checked automatically"}
        </p>
        <p className="text-muted-foreground">
          A domain starts routing once its DNS points at this server
          {serverIp ? (
            <>
              {" "}
              (A record →{" "}
              <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
                {serverIp}
              </code>
              )
            </>
          ) : null}
          .{" "}
          {disabled ? (
            <>Once the record is in place, hit Verify on the domain.</>
          ) : (
            <>
              While you’re on this page deplo re-checks DNS every 30 seconds
              and starts routing the moment the record resolves — no manual
              step needed. Verify forces an immediate check.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
