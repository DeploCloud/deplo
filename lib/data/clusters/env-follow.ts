import "server-only";

import { parseDocument } from "yaml";
import { appConnectorService } from "../../deploy/app-connector";
import { appEnv } from "../../deploy/build/deploy-env";
import { escapeComposeDollars } from "../../deploy/compose-stack/compose-read";
import { messageOf, usesComposeStack } from "../../utils";
import { loadAppGraph } from "../app-graph-load";
import { instanceFrozen } from "../deplo-move/freeze";
import { refreshAppBundle } from "./app-restore";
import { type FailoverStack, inBackground, storedBundle } from "./bundles";

// A cluster App's variables follow it to the other servers as they change, not at its next deploy: a failover
// starts it with the variables it has now.

const sameVars = (a: Record<string, string>, b: Record<string, string>) => {
  const ak = Object.keys(a);
  return ak.length === Object.keys(b).length && ak.every((k) => a[k] === b[k]);
};

/**
 * The stack with `vars` in place of the variables it was deployed with. A single image carries them in its
 * service's `environment:`, where Deplo's own entries (PORT) stay; a compose stack reads them from its env file.
 */
export function withVars(
  stack: FailoverStack,
  vars: Record<string, string>,
  composeStack: boolean,
): FailoverStack {
  if (composeStack) return { ...stack, env: { ...vars }, vars: { ...vars } };
  const doc = parseDocument(stack.composeYaml);
  const services = ((doc.toJS() as { services?: Record<string, unknown> })
    ?.services ?? {}) as Record<string, { environment?: unknown } | null>;
  const service = Object.keys(services).find(
    (n) => n !== appConnectorService(stack.slug),
  );
  if (!service) return stack;
  const raw = services[service]?.environment;
  // A single image's environment is always a map; a list form is left to the next deploy.
  if (raw != null && (typeof raw !== "object" || Array.isArray(raw)))
    return stack;
  const env = (raw ?? {}) as Record<string, unknown>;
  const before = stack.vars ?? {};
  const kept: Record<string, string> = {};
  for (const [k, v] of Object.entries(env))
    // What the deploy itself put there is kept; without a record of the variables, only PORT is known to be Deplo's.
    if (stack.vars ? !(k in before) : k === "PORT") kept[k] = String(v);
  const next: Record<string, string> = { ...kept };
  for (const [k, v] of Object.entries(vars)) next[k] = escapeComposeDollars(v);
  if (Object.keys(next).length === 0)
    doc.deleteIn(["services", service, "environment"]);
  else doc.setIn(["services", service, "environment"], next);
  return {
    ...stack,
    composeYaml: doc.toString({ lineWidth: 0 }),
    vars: { ...vars },
  };
}

/** One App: its leader is handed the stack with the variables it has now, when they changed. */
export async function followAppEnv(appId: string): Promise<boolean> {
  if (await instanceFrozen()) return false;
  const app = await loadAppGraph(appId);
  if (!app?.clusterId) return false;
  const held = await storedBundle(appId);
  if (!held) return false;
  const vars = await appEnv(appId, "production");
  if (held.stack.vars && sameVars(held.stack.vars, vars)) return false;
  await refreshAppBundle(appId, (stack) =>
    withVars(stack, vars, usesComposeStack(app)),
  );
  return true;
}

/** After an App's variables changed: in the background, behind its other bundle pushes. */
export function followAppEnvSoon(appId: string): void {
  inBackground(appId, async () => {
    await followAppEnv(appId).catch((e) =>
      console.warn(`[env-follow] ${appId}: ${messageOf(e)}`),
    );
  });
}
