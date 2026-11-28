"use client";

import * as React from "react";
import { ChevronRight } from "lucide-react";
import Link from "@/components/ui/link";
import { AppLogo } from "@/components/shared/project-logo";
import { DB_LOGOS } from "@/components/storage/db-engines";
import { METRICS } from "@/components/monitoring/metric-panel";
import { gqlAction } from "@/lib/graphql-client";
import type { ServerWorkload } from "@/lib/data/servers/workloads";
import type { DatabaseType } from "@/lib/types/database";
import { friendlyBytes } from "@/lib/utils";

type Row = Pick<
  ServerWorkload,
  "id" | "name" | "logo" | "logoTone" | "engine" | "href" | "cpu" | "memUsed"
>;

const QUERY = /* GraphQL */ `
  query MonitoringTopApps($id: String!) {
    serverWorkloads(id: $id) {
      id
      name
      logo
      logoTone
      engine
      href
      cpu
      memUsed
    }
  }
`;

const POLL_MS = 10_000;
const SHOWN = 5;

// The apps behind the chart: who is using this server's CPU or memory right now.
export function TopApps({
  serverId,
  metric,
}: {
  serverId: string;
  metric: "cpu" | "memory";
}) {
  const [rows, setRows] = React.useState<{ id: string; rows: Row[] } | null>(
    null,
  );

  React.useEffect(() => {
    let active = true;
    const load = async () => {
      const res = await gqlAction<{ serverWorkloads: Row[] }>(QUERY, {
        id: serverId,
      });
      if (active && res.ok && res.data)
        setRows({ id: serverId, rows: res.data.serverWorkloads });
    };
    void load();
    const iv = setInterval(load, POLL_MS);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [serverId]);

  const all = rows?.id === serverId ? rows.rows : [];
  const value = (w: Row) => (metric === "cpu" ? w.cpu : w.memUsed) ?? 0;
  const top = all
    .filter((w) => value(w) > 0)
    .sort((a, b) => value(b) - value(a))
    .slice(0, SHOWN);
  if (top.length === 0) return null;
  const max = value(top[0]);

  return (
    <section className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-medium">
          Using the most {metric === "cpu" ? "CPU" : "memory"}
        </h2>
        <Link
          href={`/settings/servers/${serverId}?tab=apps`}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          All {all.length} apps
          <ChevronRight className="size-3.5" />
        </Link>
      </div>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border">
        {top.map((w) => {
          const engine = w.engine as DatabaseType | null;
          const body = (
            <>
              <span className="flex min-w-0 items-center gap-3">
                <AppLogo
                  logo={w.logo ?? (engine ? DB_LOGOS[engine] : null)}
                  tone={w.logoTone}
                  size={22}
                />
                <span className="truncate text-sm font-medium">{w.name}</span>
              </span>
              <span className="hidden h-1.5 rounded-full bg-secondary sm:block">
                <span
                  className="block h-full rounded-full"
                  style={{
                    width: `${(value(w) / max) * 100}%`,
                    background: METRICS[metric].color,
                  }}
                />
              </span>
              <span className="text-right text-sm tabular-nums">
                {metric === "cpu"
                  ? `${value(w).toFixed(1)}%`
                  : friendlyBytes(value(w))}
              </span>
              <ChevronRight className="size-4 text-muted-foreground" />
            </>
          );
          const row =
            "grid h-12 grid-cols-[minmax(0,1fr)_5rem_1rem] items-center gap-5 px-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,13rem)_5rem_1rem]";
          return (
            <li key={w.id}>
              {w.href ? (
                <Link
                  href={w.href}
                  className={`${row} transition-colors hover:bg-surface`}
                >
                  {body}
                </Link>
              ) : (
                <div className={row}>{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
