"use client";

import * as React from "react";
import { usagePeak, type ResourceSize } from "@/lib/apps/resource-limits-model";
import { gqlAction } from "@/lib/graphql-client";

const POLL_MS = 5_000;

// UsageSample is one buffered metrics sample - the slice of `ContainerMetricsSample` read here.
export interface UsageSample {
  ts: number;
  online: boolean;
  cpu: number;
  memUsed: number;
  running: number;
}

// LiveUsage is the polled window plus the readings the meters and captions draw from it.
export interface LiveUsage {
  samples: UsageSample[];
  peak: ResourceSize | null;
  last: UsageSample | undefined;
  current: UsageSample | null;
}

export function useLiveUsage({
  kind,
  id,
  usage,
}: {
  kind: "app" | "database";
  id: string;
  usage: UsageSample[] | null;
}): LiveUsage {
  const [samples, setSamples] = React.useState<UsageSample[]>(() =>
    (usage ?? []).filter((s) => s.online),
  );
  const historyField =
    kind === "app" ? "appMetricsHistory" : "databaseMetricsHistory";
  const idArg = kind === "app" ? "appId" : "databaseId";
  React.useEffect(() => {
    if (!usage) return;
    let active = true;
    const read = async () => {
      if (document.visibilityState === "hidden") return;
      const res = await gqlAction<Record<string, UsageSample[]>, UsageSample[]>(
        `query($id: String!) {
           ${historyField}(${idArg}: $id) { ts online cpu memUsed running }
         }`,
        { id },
        (d) => d[historyField] ?? [],
      );
      if (!active || !res.ok || !res.data?.length) return;
      setSamples(res.data.filter((s) => s.online));
    };
    const iv = setInterval(read, POLL_MS);
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [usage, id, historyField, idArg]);

  const peak = React.useMemo(() => usagePeak(samples), [samples]);
  const last = samples[samples.length - 1];
  const current = last && last.running > 0 ? last : null;

  return { samples, peak, last, current };
}
