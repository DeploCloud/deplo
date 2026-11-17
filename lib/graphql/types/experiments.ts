import { builder } from "../builder";
import {
  EXPERIMENT_META,
  EXPERIMENTS,
  type ExperimentKey,
} from "@/lib/experiments";
import {
  experiments,
  listExperimentStates,
  setExperiment,
  type ExperimentState,
} from "@/lib/data/experiments";

export const ExperimentKeyEnum = builder.enumType("ExperimentKey", {
  values: EXPERIMENTS,
});

const ExperimentRef = builder
  .objectRef<{ key: ExperimentKey; enabled: boolean }>("Experiment")
  .implement({
    description:
      "A feature that is still new. An instance admin turns it on for every team in Settings > Deplo > Experiments.",
    fields: (t) => ({
      key: t.field({ type: ExperimentKeyEnum, resolve: (e) => e.key }),
      label: t.string({ resolve: (e) => EXPERIMENT_META[e.key].label }),
      enabled: t.exposeBoolean("enabled"),
    }),
  });

const ExperimentStateRef = builder
  .objectRef<ExperimentState>("ExperimentState")
  .implement({
    description: "An experiment as its switch shows it, with what uses it.",
    fields: (t) => ({
      key: t.field({ type: ExperimentKeyEnum, resolve: (e) => e.key }),
      label: t.string({ resolve: (e) => EXPERIMENT_META[e.key].label }),
      enabled: t.exposeBoolean("enabled"),
      usage: t.exposeString("usage", {
        nullable: true,
        description: 'What uses it right now, e.g. "2 apps, 5 jobs".',
      }),
      lockedOn: t.exposeString("lockedOn", {
        nullable: true,
        description:
          "Why it cannot be turned off right now: a cluster or a tunnel still exists.",
      }),
    }),
  });

builder.queryFields((t) => ({
  experiments: t.field({
    type: [ExperimentRef],
    authScopes: { loggedIn: true },
    description: "Which experiments are turned on for this Deplo.",
    resolve: async () => {
      const flags = await experiments();
      return EXPERIMENTS.map((key) => ({ key, enabled: flags[key] }));
    },
  }),
  instanceExperiments: t.field({
    type: [ExperimentStateRef],
    authScopes: { instanceAdmin: true },
    description: "Every experiment with what uses it. Instance admins only.",
    resolve: () => listExperimentStates(),
  }),
}));

builder.mutationFields((t) => ({
  setExperiment: t.field({
    type: ExperimentStateRef,
    authScopes: { instanceAdmin: true },
    unauthorizedError: () =>
      "Only an instance admin can turn an experiment on or off.",
    description:
      "Turn an experiment on or off for every team. Off pauses it and keeps every app's own setting; a cluster or a tunnel that still exists refuses it.",
    args: {
      key: t.arg({ type: ExperimentKeyEnum, required: true }),
      enabled: t.arg.boolean({ required: true }),
    },
    resolve: (_r, { key, enabled }) => setExperiment(key, enabled),
  }),
}));
