// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import type { LogLine } from "./types";

/**
 * Where a build's time went, derived from the `command` lines it already logged.
 * No stored boundaries: `deployment_logs.ts` is a per-line timestamp and every
 * phase already announces itself with a command.
 */

export type BuildPhaseKey =
  "initialize" | "clone" | "extract" | "pull" | "prepare" | "build" | "deploy";

const LABEL: Record<BuildPhaseKey, string> = {
  initialize: "Initialize",
  clone: "Clone",
  extract: "Extract",
  pull: "Pull",
  prepare: "Prepare",
  build: "Build",
  deploy: "Deploy",
};

export interface BuildPhase {
  key: BuildPhaseKey;
  label: string;
  /** Epoch ms this phase opened. */
  startMs: number;
  ms: number;
}

/**
 * Which phase a `command` line opens, or null when it opens none - an
 * unrecognized command keeps the running phase rather than inventing a segment.
 * The strings are the ones the control plane and the server agent actually emit.
 */
function phaseForCommand(text: string): BuildPhaseKey | null {
  const t = text.trim();
  if (t.startsWith("git clone ")) return "clone";
  if (t.startsWith("extract ")) return "extract";
  if (t.startsWith("docker pull ")) return "pull";
  if (t.startsWith("nixpacks ") || t.startsWith("railpack ")) return "prepare";
  if (t.startsWith("docker build")) return "build";
  if (t.startsWith("docker compose ")) return "deploy";
  return null;
}

/**
 * Split a build into its phases. Empty when there is nothing honest to draw: no
 * claim yet (still queued), or not one recognized boundary - a single segment
 * covering the whole build would name a phase it cannot vouch for.
 */
export function buildPhases(opts: {
  logs: readonly LogLine[];
  startedAt: string | null;
  buildDurationMs: number | null;
  /** `Date.now()`, used only while the build is still running. */
  nowMs: number;
}): BuildPhase[] {
  const { logs, startedAt, buildDurationMs, nowMs } = opts;
  if (!startedAt) return [];
  const t0 = Date.parse(startedAt);
  if (Number.isNaN(t0)) return [];
  const end = Math.max(
    t0,
    buildDurationMs != null ? t0 + buildDurationMs : nowMs,
  );

  const opened: { key: BuildPhaseKey; at: number }[] = [
    { key: "initialize", at: t0 },
  ];
  let boundaries = 0;
  for (const line of logs) {
    if (line.level !== "command") continue;
    const key = phaseForCommand(line.text);
    // Consecutive commands of the same phase are one phase: the control plane
    // and the agent both log the clone, and a build is `docker build` + relabel.
    if (!key || key === opened[opened.length - 1].key) continue;
    const at = Date.parse(line.ts);
    if (Number.isNaN(at)) continue;
    // A reattach re-stamps replayed lines with the time they were replayed, so a
    // boundary can arrive out of order. Clamping keeps the total exact.
    opened.push({
      key,
      at: Math.min(Math.max(at, opened[opened.length - 1].at), end),
    });
    boundaries++;
  }
  if (boundaries === 0) return [];

  return opened.map((phase, i) => ({
    key: phase.key,
    label: LABEL[phase.key],
    startMs: phase.at,
    ms: (opened[i + 1]?.at ?? end) - phase.at,
  }));
}
