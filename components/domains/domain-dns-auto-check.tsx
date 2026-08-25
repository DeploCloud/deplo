"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { gqlAction } from "@/lib/graphql-client";
import { useAppCan } from "@/components/apps/app-capabilities";

/** How often unsettled domains are re-checked. One DNS resolve per domain, and
 * the server skips the routing re-apply when nothing changed. */
const CHECK_INTERVAL_MS = 30_000;

/** The slice of a domain row the checker needs: identity for the mutation,
 * name for the toast, status to detect a flip. */
export interface UnsettledDomain {
  id: string;
  name: string;
  status: string;
}

/**
 * The "waiting for DNS" callout, and the polling behind it: re-runs the check on
 * mount and every {@link CHECK_INTERVAL_MS}, skipping hidden tabs. Gated on
 * `manage_domains` - without it the callout drops its "automatic" claim.
 */
export function DomainDnsAutoCheck({
  domains,
  serverIp,
}: {
  /** Domains a further check could still move. A `cloudflare` host is excluded:
   * re-resolving it only ever returns anycast IPs, so polling never learns. */
  domains: UnsettledDomain[];
  /** The public IPv4 these domains' A records must point at (this app's
   * server), shown in the callout. Absent when no usable IP is recorded. */
  serverIp?: string;
}) {
  const router = useRouter();
  const canVerify = useAppCan("manage_domains");
  const [checking, setChecking] = React.useState(false);
  const [disabled, setDisabled] = React.useState(!canVerify);

  // The poll loop reads the CURRENT props through a ref so the single mounted
  // interval survives router.refresh() prop updates without re-arming. Synced
  // in an effect (not during render — react-hooks/refs).
  const domainsRef = React.useRef(domains);
  React.useEffect(() => {
    domainsRef.current = domains;
  }, [domains]);

  React.useEffect(() => {
    if (!canVerify) return;
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
          /* GraphQL */ `
            mutation ($id: String!) {
              verifyDomain(id: $id) {
                id
                status
              }
            }
          `,
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
  }, [router, canVerify]);

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
          {disabled
            ? "Waiting for DNS"
            : "Waiting for DNS — checked automatically"}
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
            canVerify ? (
              <>Once the record is in place, hit Verify on the domain.</>
            ) : (
              <>It starts routing on its own once the record is in place.</>
            )
          ) : (
            <>
              While you’re on this page deplo re-checks DNS every 30 seconds and
              starts routing the moment the record resolves — no manual step
              needed. Verify forces an immediate check.
            </>
          )}
        </p>
      </div>
    </div>
  );
}
