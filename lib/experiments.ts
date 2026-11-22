// see https://deplo.build/docs/operations/experiments
export const EXPERIMENTS = [
  "crons",
  "zeroDowntime",
  "pullRequests",
  "clusters",
  "canary",
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
  canary: {
    label: "Canary releases",
    description:
      "Every new version of Deplo shows up as an update, before it is marked stable.",
  },
};

export const NO_EXPERIMENTS: ExperimentFlags = {
  crons: false,
  zeroDowntime: false,
  pullRequests: false,
  clusters: false,
  canary: false,
};

export function experimentOffMessage(key: ExperimentKey): string {
  return `${EXPERIMENT_META[key].label} are not turned on for this Deplo. An instance admin can turn them on in Settings > Deplo > Experiments.`;
}
