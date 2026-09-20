import "server-only";

import { eq } from "drizzle-orm";

import { getDb } from "../db/client";
import { apps as appsTable } from "../db/schema/control-plane/apps";
import { domains as domainsTable } from "../db/schema/control-plane/domains";
import { nowIso } from "../ids";
import { publishAppChanged } from "../graphql/pubsub";
import { connectAgent } from "../infra/agent-client/connect";
import type { AgentConnection } from "../infra/agent-client/connection";
import { AgentUnreachableError } from "../infra/agent-client/errors";
import { VOLUME_USAGE_CAPABILITY } from "../infra/agent-client/hello-capabilities";
import {
  wildcardEmbeddedIp,
  rehostWildcard,
  resolveServerIp,
} from "../deploy/domains";
import { stopPreviewsForServerChange } from "../deploy/preview-lifecycle/close";
import type { App } from "../types/app";
import { recordActivity } from "./activity";
import { loadAppGraph, loadDomainsForApp } from "./app-graph-load";
import { clearDataCopyError, markDataCopyFailed } from "./data-copy";
import { withKeyedLock } from "./keyed-mutex";
import {
  appHasFilesDir,
  appMoveLeftBehind,
  appMoveVolumeNames,
  appOwnVolumeNames,
  assertSafeVolumeNames,
} from "./project-backup-descriptor";
import { getServerById } from "./servers/roster";
import { dropTeardown, teardownOrQueue } from "./teardown-queue";
import {
  destroyStackOn,
  filesDirHasContent,
  migrateWorkloadData,
  startStackOn,
  stopStackOn,
} from "./volume-migration";

type Emit = (level: "info" | "warn" | "error", text: string) => void;

export type MoveOutcome = "done" | "nothing" | "rolled-back" | "held";

export async function completePendingAppMigration(
  appId: string,
  deployedOn: string,
  emit: Emit,
): Promise<MoveOutcome> {
  return withKeyedLock(`app-lifecycle:${appId}`, () =>
    runMigration(appId, deployedOn, emit),
  );
}

const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

const isUnreachable = (e: unknown): boolean =>
  e instanceof AgentUnreachableError ||
  (e as { name?: string } | null)?.name === "AgentUnreachableError";

async function serverName(id: string): Promise<string> {
  return (await getServerById(id))?.name ?? id;
}

async function presentVolumes(
  agent: AgentConnection,
  names: string[],
): Promise<string[]> {
  if (names.length === 0) return names;
  try {
    const hello = await agent.hello();
    if (!hello.capabilities?.includes(VOLUME_USAGE_CAPABILITY)) return names;
    const usage = await agent.volumeUsage(names);
    return names.filter((n) => usage.has(n));
  } catch {
    return names;
  }
}

async function runMigration(
  appId: string,
  deployedOn: string,
  emit: Emit,
): Promise<MoveOutcome> {
  const app = await loadAppGraph(appId);
  const from = app?.migrateFromServerId;
  if (!app || !from) return "nothing";
  const to = app.serverId;
  const slug = app.slug;

  if (from === to) {
    await clearMarker(appId);
    return "nothing";
  }
  if (deployedOn !== to) {
    const [here, there] = await Promise.all([
      serverName(deployedOn),
      serverName(to),
    ]);
    emit(
      "warn",
      `This deploy ran on ${here}, but the app has since been moved to ${there}. ` +
        `The stack on ${here} is being removed; the next deploy on ${there} completes the move.`,
    );
    await teardownOrQueue(strayEntry(app, deployedOn)).catch(() => {});
    return "nothing";
  }

  const [fromName, toName] = await Promise.all([
    serverName(from),
    serverName(to),
  ]);
  emit("info", `Copying ${app.name}'s data from ${fromName}…`);

  let names: string[];
  let hasStack: boolean;
  let includeFiles = appHasFilesDir(app);
  let leftBehind: string[];
  try {
    const old = await connectAgent(from);
    try {
      const stack = await old.readStack(slug);
      hasStack = stack.exists;
      const yaml = stack.exists ? stack.yaml : "";
      names = appMoveVolumeNames(app, yaml);
      assertSafeVolumeNames(slug, names);
      leftBehind = appMoveLeftBehind(app, yaml);
      if (!hasStack) {
        names = await presentVolumes(old, names);
        if (includeFiles)
          includeFiles = await filesDirHasContent(old, slug).catch(() => true);
      }
    } finally {
      old.close();
    }
  } catch (e) {
    return isUnreachable(e)
      ? hold(app, { fromName, toName, error: e, newStopped: false }, emit)
      : rollback(
          app,
          { fromName, toName, error: e, oldStopped: false, newStopped: false },
          emit,
        );
  }
  for (const item of leftBehind)
    emit(
      "warn",
      `The ${item} is not copied by a move - it stays on ${fromName}. Recreate it on ${toName} if the app needs it.`,
    );

  if (names.length === 0 && !includeFiles) {
    if (hasStack) await destroyStackOn(from, slug, false).catch(() => {});
    await clearMarker(appId);
    emit(
      "info",
      hasStack
        ? `No persistent data to copy; the stack on ${fromName} was stopped and removed (its volumes, if any, were left in place).`
        : `Nothing of ${app.name} was on ${fromName}, so there was nothing to copy.`,
    );
    return "nothing";
  }

  let newStopped = false;
  let oldStopped = false;
  try {
    await stopStackOn(to, slug);
    newStopped = true;
  } catch (e) {
    return rollback(
      app,
      { fromName, toName, error: e, oldStopped, newStopped },
      emit,
    );
  }
  if (hasStack) {
    try {
      await stopStackOn(from, slug);
      oldStopped = true;
    } catch (e) {
      return isUnreachable(e)
        ? hold(app, { fromName, toName, error: e, newStopped }, emit)
        : rollback(
            app,
            { fromName, toName, error: e, oldStopped, newStopped },
            emit,
          );
    }
  }

  let moved: { missing: string[] };
  try {
    moved = await migrateWorkloadData(from, to, {
      volumeNames: names,
      filesSlug: includeFiles ? slug : undefined,
    });
  } catch (e) {
    return rollback(
      app,
      { fromName, toName, error: e, oldStopped, newStopped },
      emit,
    );
  }
  if (moved.missing.length > 0)
    emit(
      "warn",
      `${moved.missing.join(", ")} was not on ${fromName}, so nothing was copied for it. ` +
        `Its volumes there are kept, in case the app was running with data under another name.`,
    );

  let newUp = true;
  try {
    await startStackOn(to, slug);
  } catch (e) {
    newUp = false;
    emit(
      "warn",
      `Data copied, but the stack did not start on ${toName} (${errMsg(e)}). Redeploy to bring it up.`,
    );
  }

  let teardownNote = "";
  if (moved.missing.length > 0) {
    await destroyStackOn(from, slug, false).catch((e) => {
      teardownNote = ` The stack on ${fromName} could not be stopped (${errMsg(e)}).`;
    });
  } else if (hasStack || names.length > 0) {
    const gone = await teardownOrQueue(strayEntry(app, from, names)).catch(
      () => false,
    );
    if (!gone)
      teardownNote = ` ${fromName} did not answer; Deplo keeps retrying the teardown there.`;
  }

  await clearMarker(appId);
  await clearDataCopyError({ kind: "app", id: appId });
  emit(
    teardownNote || !newUp ? "warn" : "info",
    `${app.name}'s data is on ${toName}.` + teardownNote,
  );
  await recordActivity(
    "app",
    `Moved ${app.name}'s data from ${fromName} to ${toName}`,
    "system",
    appId,
  );
  return "done";
}

function strayEntry(app: App, serverId: string, reclaim?: string[]) {
  return {
    serverId,
    deployKey: app.slug,
    projectLabel: app.id,
    label: app.name,
    teamId: app.teamId,
    reclaimVolumes: reclaim ?? appOwnVolumeNames(app),
  };
}

async function rollback(
  app: App,
  ctx: {
    fromName: string;
    toName: string;
    error: unknown;
    oldStopped: boolean;
    newStopped: boolean;
  },
  emit: Emit,
): Promise<MoveOutcome> {
  const from = app.migrateFromServerId!;
  const to = app.serverId;
  let oldUp = true;
  if (ctx.oldStopped)
    oldUp = await startStackOn(from, app.slug).then(
      () => true,
      () => false,
    );
  await relocate(app, from, oldUp ? "active" : "error");
  await teardownOrQueue(strayEntry(app, to)).catch(() => {});
  publishAppChanged(app.id);
  emit(
    "error",
    `Failed to copy ${app.name}'s data to ${ctx.toName} (${errMsg(ctx.error)}). ` +
      `The move was rolled back - the app is still on ${ctx.fromName}` +
      (oldUp
        ? "."
        : `, but its stack did not restart there: press Start, or redeploy.`),
  );
  await recordActivity(
    "app",
    `Moving ${app.name} to ${ctx.toName} failed - it stays on ${ctx.fromName}`,
    "system",
    app.id,
  );
  return "rolled-back";
}

async function hold(
  app: App,
  ctx: {
    fromName: string;
    toName: string;
    error: unknown;
    newStopped: boolean;
  },
  emit: Emit,
): Promise<MoveOutcome> {
  if (!ctx.newStopped)
    await stopStackOn(app.serverId, app.slug).catch(() => {});
  await markDataCopyFailed(
    { kind: "app", id: app.id },
    `${ctx.fromName} could not be reached to copy it: ${errMsg(ctx.error)}`,
  );
  await getDb()
    .update(appsTable)
    .set({ status: "error", updatedAt: nowIso() })
    .where(eq(appsTable.id, app.id));
  publishAppChanged(app.id);
  emit(
    "error",
    `${ctx.fromName} could not be reached (${errMsg(ctx.error)}), so ${app.name}'s data was not copied. ` +
      `The app is kept stopped on ${ctx.toName}: redeploy once ${ctx.fromName} is back to copy it, ` +
      `or choose "Deploy anyway" on the app page to start without it.`,
  );
  return "held";
}

async function relocate(
  app: App,
  serverId: string,
  status: "active" | "error",
): Promise<void> {
  await dropTeardown(serverId, app.slug);
  const [leaving, arriving] = await Promise.all([
    getServerById(app.serverId),
    getServerById(serverId),
  ]);
  const oldIp = resolveServerIp(leaving ?? undefined);
  const newIp = resolveServerIp(arriving ?? undefined);
  const rehost = (host: string) =>
    wildcardEmbeddedIp(host) === oldIp ? rehostWildcard(host, newIp) : host;
  await getDb().transaction(async (tx) => {
    await tx
      .update(appsTable)
      .set({
        serverId,
        buildServerId:
          app.buildServerId === app.serverId ? serverId : app.buildServerId,
        migrateFromServerId: null,
        status,
        productionUrl: app.productionUrl
          ? app.productionUrl.replace(
              /^(https?:\/\/)([^/]+)/,
              (_m, scheme: string, host: string) => scheme + rehost(host),
            )
          : app.productionUrl,
        updatedAt: nowIso(),
      })
      .where(eq(appsTable.id, app.id));
    if (newIp === oldIp) return;
    for (const dom of await loadDomainsForApp(app.id, tx)) {
      if (dom.source !== "auto") continue;
      const name = rehost(dom.name);
      if (name === dom.name) continue;
      await tx
        .update(domainsTable)
        .set({ name })
        .where(eq(domainsTable.id, dom.id));
    }
  });
  const [row] = await getDb()
    .select({ previewServerId: appsTable.previewServerId })
    .from(appsTable)
    .where(eq(appsTable.id, app.id));
  if (row && !row.previewServerId)
    await stopPreviewsForServerChange(app.id, serverId).catch(() => {});
}

async function clearMarker(appId: string): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ migrateFromServerId: null })
    .where(eq(appsTable.id, appId));
}
