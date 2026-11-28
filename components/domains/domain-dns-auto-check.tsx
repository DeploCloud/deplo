"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { gqlAction } from "@/lib/graphql-client";
import { dnsRecordsFor } from "@/lib/host-address";
import { useAppCan } from "@/components/apps/app-capabilities";
import { Countdown, useNow } from "@/components/shared/live-state";
import { DomainNoticeContent } from "./domain-notice-content";

const CHECK_INTERVAL_MS = 30_000;
// Resolvers forget a record within its TTL: Cloudflare's proxied ones live 5 minutes.
const CACHES_FORGET_MS = 5 * 60_000;

/** The record a domain the cluster's zone answers needs: a CNAME into the zone, never an address of one server. */
export interface ZoneRecord {
  target: string;
  check: { name: string; target: string } | null;
  /** Deplo writes it in Cloudflare itself. */
  kept: boolean;
}

export interface UnsettledDomain {
  id: string;
  name: string;
  status: string;
  zone?: ZoneRecord | null;
  recordSwitchedAt?: string | null;
}

const Code = ({ children }: { children: React.ReactNode }) => (
  <code className="rounded bg-muted px-1 py-0.5 font-mono text-foreground">
    {children}
  </code>
);

export function DomainDnsAutoCheck({
  domains,
  serverIp,
  serverIpv6,
  action,
}: {
  domains: UnsettledDomain[];
  serverIp?: string | null;
  serverIpv6?: string | null;
  action?: React.ReactNode;
}) {
  // A domain of a cluster's zone needs its CNAME, so the server's addresses are shown only for the others.
  const plain = domains.filter((d) => !d.zone);
  const records = plain.length > 0 ? dnsRecordsFor(serverIp, serverIpv6) : [];
  const now = useNow(domains.some((d) => d.recordSwitchedAt));
  const switched = domains.filter(
    (d) =>
      d.recordSwitchedAt &&
      now - Date.parse(d.recordSwitchedAt) < CACHES_FORGET_MS,
  );
  const router = useRouter();
  const canVerify = useAppCan("manage_domains");
  const [checking, setChecking] = React.useState(false);
  const [disabled, setDisabled] = React.useState(!canVerify);

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
            toast.success(`${d.name} verified - routing is live`);
          else if (status === "cloudflare")
            toast.warning(
              `${d.name} is proxied through Cloudflare - routed, but Deplo can’t confirm it reaches this app`,
            );
        }
      }
      running = false;
      setChecking(false);
      if (cancelled) return;
      if (failures > 0 && failures === domainsRef.current.length) {
        if (++failedRounds >= 2) {
          setDisabled(true);
          cancelled = true;
        }
      } else {
        failedRounds = 0;
      }
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
    <div className="flex items-start gap-2.5 rounded-xl border border-border bg-surface px-3.5 py-2.5 text-sm">
      <RefreshCw
        className={
          checking
            ? "mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
            : "mt-0.5 size-4 shrink-0 text-muted-foreground"
        }
      />
      <DomainNoticeContent action={action}>
        <p className="font-medium">
          {disabled
            ? "Waiting for DNS"
            : "Waiting for DNS - checked automatically"}
        </p>
        {domains
          .filter((d) => d.zone)
          .map((d) => (
            <p key={d.id} className="text-muted-foreground">
              {d.zone!.kept ? (
                <>
                  Deplo wrote <Code>{d.name}</Code> →{" "}
                  <Code>{d.zone!.target}</Code> in Cloudflare.
                </>
              ) : (
                <>
                  CNAME <Code>{d.name}</Code> → <Code>{d.zone!.target}</Code>
                  {d.zone!.check ? (
                    <>
                      {" "}
                      (optional: CNAME <Code>{d.zone!.check.name}</Code> →{" "}
                      <Code>{d.zone!.check.target}</Code>)
                    </>
                  ) : null}
                </>
              )}
            </p>
          ))}
        {plain.length > 0 && (
          <p className="text-muted-foreground">
            Point it at this server
            {records.length > 0 ? (
              <>
                {": "}
                {records.map((r, i) => (
                  <React.Fragment key={r.type}>
                    {i > 0 ? ", " : null}
                    {r.type} → <Code>{r.value}</Code>
                  </React.Fragment>
                ))}
              </>
            ) : null}
            .
          </p>
        )}
        {switched.map((d) => (
          <div key={d.id} className="mt-2">
            <Countdown
              until={Date.parse(d.recordSwitchedAt!) + CACHES_FORGET_MS}
              total={CACHES_FORGET_MS}
              label={`Caches forget ${d.name}'s old record`}
            />
          </div>
        ))}
        <p className="text-xs text-muted-foreground">
          {disabled
            ? canVerify
              ? "Hit Verify once the record is in place."
              : "It starts routing on its own once the record is in place."
            : "Checked every 30 seconds, at the domain's own name servers."}
        </p>
      </DomainNoticeContent>
    </div>
  );
}
