"use client";

import * as React from "react";
import { toast } from "sonner";

import { CleanupPanel, type CleanupServerOption } from "./cleanup-panel";
import { CleanupHistory } from "./cleanup-history";
import { gqlSubscribe } from "@/lib/graphql-client";
import { formatBytes } from "@/lib/utils";
import type { CleanupPolicy, CleanupRunDTO } from "@/lib/data/docker-cleanup";

/**
 * The live half of the Docker cleanup page: it owns the run history and feeds both the
 * panel (which servers are being swept right now) and the table below it.
 *
 * It exists because a sweep is a BACKGROUND JOB. "Clean up now" returns the instant the
 * run is on the record — the host may still be minutes from done — so the click cannot
 * be its own progress bar, and the answer cannot be a toast that a navigation throws
 * away. The run row is the progress indicator instead: it appears immediately, spins
 * while the host works, and settles into a result whether or not anyone is looking.
 *
 * One subscription serves the whole page (the history is instance-wide, so there is
 * nothing to key it by), and it is what keeps a SCHEDULED sweep visible too — the 04:00
 * run appears on a page nobody touched, on every admin's screen at once.
 */
const CLEANUP_RUNS_SUBSCRIPTION = /* GraphQL */ `
  subscription DockerCleanupRuns {
    dockerCleanupRuns {
      id
      serverId
      serverName
      trigger
      actor
      status
      error
      reclaimedBytes
      startedAt
      finishedAt
      items {
        scope
        reclaimedBytes
        itemsRemoved
        skipped
        error
      }
    }
  }
`;

type SubResult = { dockerCleanupRuns: CleanupRunDTO[] };

export function CleanupLive({
  policy,
  servers,
  initialRuns,
}: {
  policy: CleanupPolicy;
  servers: CleanupServerOption[];
  initialRuns: CleanupRunDTO[];
}) {
  const [runs, setRuns] = React.useState(initialRuns);
  const [seeded, setSeeded] = React.useState(initialRuns);
  /**
   * The runs THIS tab started, so only the admin who clicked gets the result toast —
   * not every other open settings page, and not for the nightly sweep nobody asked for.
   * A ref, not state: it must survive the re-render the subscription causes without
   * causing one of its own.
   */
  const startedHere = React.useRef(new Set<string>());

  // Adopt a fresh server render (the page refreshes after a policy save). The
  // subscription overwrites this on its next ping anyway; adopting keeps the two from
  // disagreeing in the meantime.
  if (seeded !== initialRuns) {
    setSeeded(initialRuns);
    setRuns(initialRuns);
  }

  React.useEffect(() => {
    return gqlSubscribe<SubResult>(
      CLEANUP_RUNS_SUBSCRIPTION,
      undefined,
      (data) => {
        const next = data.dockerCleanupRuns;
        if (!next) return;
        setRuns(next);
        // Report the outcome of a sweep this tab started, once. The history already
        // shows it — the toast is only so an admin still on the page learns without
        // watching the table.
        for (const run of next) {
          if (run.status === "running" || !startedHere.current.has(run.id)) continue;
          startedHere.current.delete(run.id);
          if (run.status === "failed") {
            toast.error(run.error || `Cleanup failed on ${run.serverName}`);
          } else {
            toast.success(
              `Reclaimed ${formatBytes(run.reclaimedBytes)} on ${run.serverName}`,
            );
          }
        }
      },
      // A dropped stream self-heals (gqlSubscribe retries and the generator re-emits
      // the current snapshot), so a blip is not worth a toast. Anything terminal is
      // worth one — otherwise the table would quietly freeze.
      (e) => console.warn("[cleanup] live history stream error:", e.message),
    );
  }, []);

  /** The hosts with a sweep in flight — the button on each of them says so. */
  const runningServerIds = React.useMemo(
    () =>
      new Set(
        runs
          .filter((r) => r.status === "running")
          .map((r) => r.serverId)
          .filter((id): id is string => !!id),
      ),
    [runs],
  );

  /**
   * The mutation answers with the real `running` run, so the row is on screen before
   * the subscription's echo arrives — no optimistic placeholder to reconcile, just the
   * same row arriving twice.
   */
  function onStarted(run: CleanupRunDTO) {
    startedHere.current.add(run.id);
    setRuns((prev) => [run, ...prev.filter((r) => r.id !== run.id)]);
  }

  return (
    <>
      <CleanupPanel
        policy={policy}
        servers={servers}
        runningServerIds={runningServerIds}
        onStarted={onStarted}
      />
      <CleanupHistory runs={runs} />
    </>
  );
}
