import type { LogLine } from "./types/deployment";

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
  startMs: number;
  ms: number;
}

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

export function buildPhases(opts: {
  logs: readonly LogLine[];
  startedAt: string | null;
  buildDurationMs: number | null;
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
    if (!key || key === opened[opened.length - 1].key) continue;
    const at = Date.parse(line.ts);
    if (Number.isNaN(at)) continue;
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
