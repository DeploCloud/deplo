import "server-only";

import { errorMessage } from "../../utils";
import { blocker, type Note } from "../../migration/note";
import { randomToken } from "../../crypto";
import type { SourceCredential } from "../../migration/source";
import type {
  NativePreview,
  SourceApplication,
  SourceCompose,
} from "../../migration/model";
import {
  mapResources,
  swarmHealthCheck,
} from "../../migration/map/app-settings";
import { parseEnvBlob } from "../../migration/map/env";
import type { createApp } from "../apps/create";
import { updateAppResources } from "../apps/resources";
import { updateAppHealthCheck } from "../apps/settings";
import { addBasicAuthUser } from "../basic-auth";
import { landNativeOps } from "./app-ops";
import { type AddressRules, rehostPairs } from "./app-address-vars";
import { importCrons } from "./cron-import";
import type { SourceService } from "./source-tree";

export const LOCK_USERNAME = "migration-lock";

// Fails closed: an app that was password-protected over there never lands open here.
export async function importBasicAuth(
  appId: string,
  security: { username: string; password: string }[],
  notes: Note[],
): Promise<void> {
  if (security.length === 0) return;
  const refused: string[] = [];
  for (const s of security) {
    try {
      await addBasicAuthUser(appId, s.username, s.password, { imported: true });
    } catch (e) {
      refused.push(`"${s.username}" (${errorMessage(e, "refused")})`);
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
      `It was password-protected over there, and none of its basic-auth users could be added here (${refused.join(", ")}; the lock: ${errorMessage(e, "refused")}). Do not deploy it until it has a password under Access.`,
    );
  }
  notes.push(
    blocker(
      `None of its basic-auth users came across (${refused.join(", ")}). So it is not left open, it is locked behind a "${LOCK_USERNAME}" user whose password nobody knows - add the real users under Access, then remove that one.`,
    ),
  );
}

// The base domain goes on its own, so a refused one does not take the other settings with it.
async function landNativePreview(
  appId: string,
  preview: NativePreview,
  servers: Map<string, string | undefined>,
  notes: Note[],
): Promise<void> {
  const { setAppPreviewSettings } = await import("../previews");
  // A new app starts with previews off; saying so again would only log a "Disabled" Activity line.
  const { baseDomain, serverId, enabled, ...rest } = preview;
  const server = serverId ? servers.get(serverId) : undefined;
  if (serverId && !server)
    notes.push(
      "Its previews ran on a server of their own on {panel}, which has no counterpart here, so they run on the app's server. Pick another under Previews.",
    );
  try {
    await setAppPreviewSettings(appId, {
      ...rest,
      ...(enabled ? { enabled } : {}),
      ...(server ? { serverId: server } : {}),
    });
  } catch (e) {
    notes.push(
      `Its preview settings did not come across: ${errorMessage(e, "refused")}. Set them under Previews.`,
    );
  }
  if (!baseDomain) return;
  try {
    await setAppPreviewSettings(appId, { baseDomain });
  } catch (e) {
    notes.push(
      `Its preview domain ${baseDomain} did not come across: ${errorMessage(e, "refused")}. Set one under Previews.`,
    );
  }
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
    servers?: Map<string, string | undefined>;
    liveCopy?: boolean;
    address?: AddressRules;
  },
  notes: Note[],
): Promise<number> {
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

  const app = detail as SourceApplication;
  if (app.nativePreview)
    await landNativePreview(
      created.id,
      app.nativePreview,
      shape.servers ?? new Map(),
      notes,
    );
  if (!isCompose || app.nativePreview) {
    if (!app.nativePreview && app.isPreviewDeploymentsActive) {
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
    let previewVars = (
      app.previewEnvEntries ?? parseEnvBlob(app.previewEnv)
    ).filter((v) => v.key);
    if (shape.address) {
      const moved = rehostPairs(
        previewVars,
        shape.address,
        (keys) =>
          `The preview ${keys.length === 1 ? "variable" : "variables"} `,
        "Previews",
      );
      previewVars = moved.pairs;
      notes.push(...moved.notes);
    }
    const previewSecrets = app.previewSecretEnvKeys
      ? new Set(app.previewSecretEnvKeys)
      : secretKeys;
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
            previewSecrets.has(v.key) ? "secret" : "plain",
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

  if (detail.nativeOps)
    await landNativeOps(created.id, detail.nativeOps, isCompose, notes);

  return importCrons(
    c,
    isCompose ? "compose" : "application",
    svc.id,
    { kind: "app", id: created.id },
    notes,
    {
      serviceRenames,
      cronEnabled: detail.cronEnabled,
      paused: shape.liveCopy,
      address: shape.address,
    },
  );
}
