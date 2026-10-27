import type { App } from "@/lib/types/app";
import { usesPastedCompose } from "@/lib/utils";

export type HintPart = string | { code: string };

export interface ProductionHint {
  auto: boolean;
  parts: HintPart[];
}

// The footer states what ships production, so it reads every switch a push goes through.
export function productionHint(
  app: Pick<App, "source" | "repo" | "compose" | "dockerImage" | "autoDeploy">,
): ProductionHint | null {
  if (usesPastedCompose(app))
    return {
      auto: false,
      parts: ["Compose changes reach production on the next redeploy."],
    };
  if (app.repo) {
    const branch = { code: app.repo.branch };
    const tags = app.repo.triggerType === "tag";
    if (!app.autoDeploy)
      return {
        auto: false,
        parts: tags
          ? ["Auto-deploy is off. New tags wait for a redeploy."]
          : ["Auto-deploy is off. Pushes to ", branch, " wait for a redeploy."],
      };
    if (tags)
      return { auto: true, parts: ["Every new tag deploys to production."] };
    if (app.repo.watchPaths?.length)
      return {
        auto: true,
        parts: [
          "Pushes to ",
          branch,
          " that touch the watched paths deploy to production.",
        ],
      };
    return {
      auto: true,
      parts: ["Every push to ", branch, " deploys to production."],
    };
  }
  if (app.source === "docker-image" && app.dockerImage)
    return {
      auto: false,
      parts: ["Redeploy to pull the latest ", { code: app.dockerImage }, "."],
    };
  if (app.source === "upload")
    return {
      auto: false,
      parts: ["Upload a new archive to update production."],
    };
  return null;
}

export interface RuntimeContainerLike {
  name: string;
  service: string;
  state: string;
  health: string;
  restartCount: number;
  startedAtUnix?: number;
  running: boolean;
  exposed: boolean;
}

export interface RuntimeLike {
  total: number;
  running: number;
  missing: string[];
  unreachable: boolean;
  containers: RuntimeContainerLike[];
}

// `dot` is a StatusDot status; `rank` puts what needs a look first.
export interface ContainerRow {
  key: string;
  label: string;
  state: string;
  dot: "running" | "restarting" | "unhealthy" | "stopped";
  rank: number;
  restarts: number;
  startedAtUnix: number;
  exposed: boolean;
  container: string | null;
}

function rowFor(c: RuntimeContainerLike): ContainerRow {
  const base = {
    key: c.name,
    label: c.service || c.name,
    restarts: c.restartCount,
    startedAtUnix: c.running ? (c.startedAtUnix ?? 0) : 0,
    exposed: c.exposed,
    container: c.name,
  };
  if (c.state === "restarting")
    return { ...base, state: "Restarting", dot: "restarting", rank: 0 };
  if (!c.running) return { ...base, state: "Stopped", dot: "stopped", rank: 1 };
  if (c.health === "unhealthy")
    return { ...base, state: "Unhealthy", dot: "unhealthy", rank: 0 };
  if (c.health === "starting")
    return { ...base, state: "Starting", dot: "unhealthy", rank: 0 };
  return { ...base, state: "Running", dot: "running", rank: 2 };
}

export function containerRows(runtime: RuntimeLike): ContainerRow[] {
  const missing: ContainerRow[] = runtime.missing.map((service) => ({
    key: `missing:${service}`,
    label: service,
    state: "Not created",
    dot: "stopped",
    rank: 1,
    restarts: 0,
    startedAtUnix: 0,
    exposed: false,
    container: null,
  }));
  return [...runtime.containers.map(rowFor), ...missing].sort(
    (a, b) => a.rank - b.rank || a.label.localeCompare(b.label),
  );
}

export function containersSummary(runtime: RuntimeLike): {
  dot: "running" | "unhealthy" | "stopped";
  text: string;
} {
  if (runtime.unreachable) return { dot: "stopped", text: "Unreachable" };
  const total = runtime.total + runtime.missing.length;
  if (total === 0) return { dot: "stopped", text: "None" };
  if (runtime.running === 0) return { dot: "stopped", text: "Stopped" };
  const rows = containerRows(runtime);
  if (rows.every((r) => r.dot === "running"))
    return { dot: "running", text: `${total} running` };
  return { dot: "unhealthy", text: `${runtime.running} of ${total} running` };
}
