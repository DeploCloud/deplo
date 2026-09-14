import "server-only";

import { sourceClient } from "../../migration/source";
import type { SourceCredential } from "../../migration/source";
import type { SourceApplication, SourceCompose } from "../../migration/model";
import {
  mapResources,
  swarmHealthCheck,
} from "../../migration/map/app-settings";
import { parseEnvBlob } from "../../migration/map/env";
import type { createApp } from "../apps/create";
import { updateAppResources } from "../apps/resources";
import { updateAppHealthCheck } from "../apps/settings";
import { addBasicAuthUser } from "../basic-auth";
import { createCronJob } from "../crons/job-crud";
import type { SourceService } from "./source-tree";

// A service name as it landed here: renamed when the import had to move it off a name
// the network already answers to.
function renamedService(
  name: string | null | undefined,
  renames: Map<string, string>,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return renames.get(trimmed.toLowerCase()) ?? trimmed;
}

// The panel's schedules for one service, as Deplo cron jobs.
async function importCrons(
  c: SourceCredential,
  scheduleType: "application" | "compose",
  sourceId: string,
  appId: string,
  notes: string[],
  // Services the import renamed, so a job still runs in its own container.
  serviceRenames: Map<string, string> = new Map(),
): Promise<void> {
  for (const s of await sourceClient(c).listSchedules(scheduleType, sourceId)) {
    const command = (s.command ?? s.script ?? "").trim();
    if (!command) {
      notes.push(`Cron "${s.name}" has no command on {panel} - not imported.`);
      continue;
    }
    try {
      await createCronJob("app", appId, {
        name: s.name,
        schedule: s.cronExpression,
        command,
        service: renamedService(s.serviceName, serviceRenames),
        enabled: s.enabled !== false,
      });
    } catch (e) {
      notes.push(
        `Cron "${s.name}" was not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }
}

// Everything Deplo stores about a running app once it exists: resource caps, its
// health check, basic-auth users, preview settings and the panel's schedules.
export async function landAppExtras(
  c: SourceCredential,
  svc: SourceService,
  detail: SourceApplication & SourceCompose,
  created: Awaited<ReturnType<typeof createApp>>,
  shape: {
    isCompose: boolean;
    secretKeys: Set<string>;
    serviceRenames: Map<string, string>;
  },
  notes: string[],
): Promise<void> {
  const { isCompose, secretKeys, serviceRenames } = shape;
  const resources = mapResources(detail);
  notes.push(...resources.notes);
  if (resources.value) {
    try {
      await updateAppResources(created.id, resources.value);
    } catch (e) {
      notes.push(
        `Resource limits were not imported: ${e instanceof Error ? e.message : "refused"}.`,
      );
    }
  }

  // One panel fills `healthCheck`, the other keeps the same thing in Swarm's own shape:
  // reading only the first reported it as unimportable.
  const health =
    (detail as SourceApplication).healthCheck ??
    swarmHealthCheck((detail as SourceApplication).healthCheckSwarm);
  if (health && !isCompose) {
    try {
      await updateAppHealthCheck(created.id, health);
    } catch (e) {
      notes.push(
        `Its health check was not imported: ${e instanceof Error ? e.message : "refused"}. Set one under Advanced.`,
      );
    }
  }

  // The credential comes across AS IT IS. Measured: a code-server arrived online and
  // open because "CoderPass123" has no special character.
  const security = (detail as SourceApplication).security ?? [];
  for (const s of security) {
    try {
      await addBasicAuthUser(created.id, s.username, s.password, {
        imported: true,
      });
    } catch (e) {
      notes.push(
        `Basic-auth user "${s.username}" was not imported: ${e instanceof Error ? e.message : "refused"}. This app answers WITHOUT that password now.`,
      );
    }
  }
  if (security.length > 0)
    notes.push(
      `${security.length === 1 ? "Its basic-auth password came" : `Its ${security.length} basic-auth passwords came`} across unchanged, so the app is protected exactly as it was. ${security.length === 1 ? "It was" : "They were"} never checked against Deplo's password rules - rotate ${security.length === 1 ? "it" : "them"} under Access when the migration is done.`,
    );

  if (!isCompose) {
    const app = detail as SourceApplication;
    if (app.isPreviewDeploymentsActive) {
      try {
        const { setAppPreviewSettings } = await import("../previews");
        // `*.preview.acme.com` over there is the base `preview.acme.com` here.
        const base = app.previewWildcard?.trim().replace(/^\*\./, "") || null;
        await setAppPreviewSettings(created.id, {
          enabled: true,
          port: app.previewPort ?? null,
          maxActive:
            typeof app.previewLimit === "number" && app.previewLimit > 0
              ? Math.min(app.previewLimit, 50)
              : null,
          ...(base ? { baseDomain: base } : {}),
        });
      } catch (e) {
        notes.push(
          `Preview deployments were on over there but did not come across: ${e instanceof Error ? e.message : "refused"}. Turn them on under Previews.`,
        );
      }
    }
    // Their own variables, as Deplo's own preview variables - a preview inherits
    // the app's, so these are the ones that differ or exist only there.
    const previewVars = parseEnvBlob(app.previewEnv).filter((v) => v.key);
    if (previewVars.length > 0) {
      const { setPreviewEnvVar } = await import("../previews");
      const landed: string[] = [];
      const refused: string[] = [];
      for (const v of previewVars) {
        try {
          await setPreviewEnvVar(
            created.id,
            v.key,
            v.value,
            secretKeys.has(v.key) ? "secret" : "plain",
          );
          landed.push(v.key);
        } catch (e) {
          refused.push(
            `${v.key} (${e instanceof Error ? e.message : "refused"})`,
          );
        }
      }
      if (landed.length > 0)
        notes.push(
          `Preview-only variable(s) came across as this app's preview variables: ${landed.join(", ")}.`,
        );
      if (refused.length > 0)
        notes.push(
          `Preview-only variable(s) that did not come across: ${refused.join("; ")}. Set them under Previews.`,
        );
    }
  }

  await importCrons(
    c,
    isCompose ? "compose" : "application",
    svc.id,
    created.id,
    notes,
    serviceRenames,
  );
}
