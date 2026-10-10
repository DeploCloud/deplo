import { stripAnsi } from "./ansi";
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
  if (t.startsWith("git clone ") || t.startsWith("git fetch ")) return "clone";
  if (t.startsWith("extract ")) return "extract";
  if (t.startsWith("docker pull ")) return "pull";
  if (
    t === "deplopack prepare" ||
    t.startsWith("nixpacks ") ||
    t.startsWith("railpack ")
  )
    return "prepare";
  if (t === "deplopack build" || t.startsWith("docker build")) return "build";
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
  let deplopack = false;
  for (const line of logs) {
    const text = stripAnsi(line.text).trim();
    let key = line.level === "command" ? phaseForCommand(text) : null;
    if (
      (line.level === "command" && text === "deplopack prepare") ||
      (line.level === "info" && text.startsWith("Building with DeploPack "))
    ) {
      deplopack = true;
      key = "prepare";
    }
    if (
      line.level === "info" &&
      text === "Starting Docker Build..." &&
      deplopack
    )
      key = "build";
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
