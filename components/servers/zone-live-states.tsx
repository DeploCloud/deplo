"use client";

import * as React from "react";

import { Countdown, LiveSteps, useEvery } from "@/components/shared/live-state";
import { useRouter } from "@/lib/nav";
import type { ClusterDnsView } from "@/lib/types/cluster-dns";

// What the cluster's name servers do now, as it moves: https://deplo.build/docs/operations/clusters/dns-zone

/** How each name server answers now: answering, failing, or leaving the answers after it went offline. */
export function ZoneServerStates({ dns }: { dns: ClusterDnsView }) {
  const router = useRouter();
  const of = dns.servers.length;
  const moving = dns.servers.some(
    (s) => s.offlineSince || s.state !== "answer",
  );
  useEvery(moving ? 5_000 : 20_000, () => router.refresh());
  if (of === 0) return null;
  return (
    <ul className="space-y-2 text-xs">
      {dns.servers.map((s) => {
        const gone = s.offlineSince
          ? Date.parse(s.offlineSince) + dns.dropAfter * 1000
          : null;
        return (
          <li key={s.serverId} className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-1.5">
              <span className="font-medium text-foreground">
                {s.serverName}
              </span>
              <span className="text-muted-foreground">
                {s.offlineSince
                  ? "Offline"
                  : s.state === "answer"
                    ? `Answers, hearing ${s.heard} of ${of}`
                    : s.state === "fail"
                      ? `Not answering: hears ${s.heard} of ${of}`
                      : s.state === "stale" || s.state === "warming"
                        ? "Answers with the last agreed servers"
                        : s.problem || "Starting"}
              </span>
            </div>
            {gone && (
              <LeavingAnswers until={gone} total={dns.dropAfter * 1000} />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LeavingAnswers({ until, total }: { until: number; total: number }) {
  const [left, setLeft] = React.useState(() => until > Date.now());
  React.useEffect(() => {
    if (!left) return;
    const id = window.setTimeout(
      () => setLeft(false),
      Math.max(0, until - Date.now()),
    );
    return () => window.clearTimeout(id);
  }, [left, until]);
  return left ? (
    <Countdown
      until={until}
      total={total}
      label="Leaves the other servers' answers"
    />
  ) : (
    <p className="text-muted-foreground">
      Left the other servers&apos; answers.
    </p>
  );
}

/** A zone's steps: made, answered by its name servers, and its certificate when it has one. */
export function ZoneSteps({
  dns,
  zone,
}: {
  dns: ClusterDnsView;
  zone: ClusterDnsView["zones"][number];
}) {
  const answering =
    dns.servers.length > 0 &&
    dns.servers.some((s) => s.serving && s.state === "answer");
  const cert = zone.certificate;
  const steps = [
    { label: "Created", state: "done" as const },
    {
      label: "Answering",
      state: answering ? ("done" as const) : ("current" as const),
    },
    ...(dns.wildcard
      ? [
          {
            label: cert.valid ? "Certificate" : "Certificate, about a minute",
            state: cert.valid
              ? ("done" as const)
              : answering && (cert.ordering || cert.error)
                ? ("current" as const)
                : ("todo" as const),
          },
        ]
      : []),
  ];
  return <LiveSteps steps={steps} />;
}
