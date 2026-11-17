// see https://deplo.build/docs/operations/experiments
export const EXPERIMENTS = [
  "crons",
  "zeroDowntime",
  "pullRequests",
  "clusters",
  "tunnels",
] as const;

export type ExperimentKey = (typeof EXPERIMENTS)[number];

export type ExperimentFlags = Record<ExperimentKey, boolean>;

export const EXPERIMENT_META: Record<
  ExperimentKey,
  { label: string; description: string }
> = {
  crons: {
    label: "Cron jobs",
    description: "Run a command on a schedule inside an app or a database.",
  },
  zeroDowntime: {
    label: "Zero-downtime deploys",
    description: "Keep the old version online until the new one is ready.",
  },
  pullRequests: {
    label: "Pull requests",
    description: "Deploy every pull request to its own URL.",
  },
  clusters: {
    label: "Server clusters",
    description: "Several servers that act as one.",
  },
  tunnels: {
    label: "Tunnels",
    description: "Reach the panel and domains through a Cloudflare Tunnel.",
  },
};

export const NO_EXPERIMENTS: ExperimentFlags = {
  crons: false,
  zeroDowntime: false,
  pullRequests: false,
  clusters: false,
  tunnels: false,
};

export function experimentOffMessage(key: ExperimentKey): string {
  return `${EXPERIMENT_META[key].label} are not turned on for this Deplo. An instance admin can turn them on in Settings > Deplo > Experiments.`;
}
