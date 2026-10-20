import "server-only";

import { randomToken } from "../../crypto";
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

function renamedService(
  name: string | null | undefined,
  renames: Map<string, string>,
): string | null {
  const trimmed = name?.trim();
  if (!trimmed) return null;
  return renames.get(trimmed.toLowerCase()) ?? trimmed;
}

async function importCrons(
  c: SourceCredential,
  scheduleType: "application" | "compose",
  sourceId: string,
  appId: string,
  notes: string[],
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

export const LOCK_USERNAME = "migration-lock";

// Fails closed: an app that was password-protected over there never lands open here.
export async function importBasicAuth(
  appId: string,
  security: { username: string; password: string }[],
  notes: string[],
): Promise<void> {
  if (security.length === 0) return;
  const refused: string[] = [];
  for (const s of security) {
    try {
      await addBasicAuthUser(appId, s.username, s.password, { imported: true });
    } catch (e) {
      refused.push(
        `"${s.username}" (${e instanceof Error ? e.message : "refused"})`,
      );
    }
  }
  const landed = security.length - refused.length;
  if (refused.length === 0) {
    notes.push(
      `${landed === 1 ? "Its basic-auth password came" : `Its ${landed} basic-auth passwords came`} across unchanged, so the app is protected exactly as it was. ${landed === 1 ? "It was" : "They were"} never checked against Deplo's password rules - rotate ${landed === 1 ? "it" : "them"} under Access when the migration is done.`,
    );
    return;
  }
  if (landed > 0) {
    notes.push(
      `Basic-auth user(s) ${refused.join(", ")} did not come across, so they cannot sign in. The app is still password-protected by the other ${landed}. Add them again under Access.`,
    );
    return;
  }
  try {
    await addBasicAuthUser(appId, LOCK_USERNAME, randomToken(24), {
      imported: true,
    });
  } catch (e) {
    throw new Error(
      `It was password-protected over there, and none of its basic-auth users could be added here (${refused.join(", ")}; the lock: ${e instanceof Error ? e.message : "refused"}). Do not deploy it until it has a password under Access.`,
    );
  }
  notes.push(
    `None of its basic-auth users came across (${refused.join(", ")}). So it is not left open, it is locked behind a "${LOCK_USERNAME}" user whose password nobody knows - add the real users under Access, then remove that one.`,
  );
}

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
  const native = (detail as SourceApplication).nativeResources;
  const resources = native
    ? { value: native, notes: [] }
    : mapResources(detail);
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

  // One panel fills healthCheck, the other keeps the same thing in Swarm's own shape.
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

  await importBasicAuth(
    created.id,
    (detail as SourceApplication).security ?? [],
    notes,
  );

  if (!isCompose) {
    const app = detail as SourceApplication;
    if (app.isPreviewDeploymentsActive) {
      try {
        const { setAppPreviewSettings } = await import("../previews");
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
    const previewVars = (
      app.previewEnvEntries ?? parseEnvBlob(app.previewEnv)
    ).filter((v) => v.key);
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
