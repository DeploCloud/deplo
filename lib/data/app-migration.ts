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
import { wildcardEmbeddedIp, rehostWildcard } from "../deploy/domains";
import { serverWildcardIp } from "./servers/addresses";
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
import {
  type Ran,
  ranLater,
  readRan,
  setAsideOn,
  setAsideOnto,
} from "./clusters/copy-aside";
import type { SetAsideCopy } from "../infra/agent-client/connection";
import { formatBytes } from "../utils";
import { placeAtLeaderFirst } from "./clusters/leader-sync";
import { getClusterById } from "./clusters/roster";
import {
  dropTeardown,
  enqueueTeardowns,
  teardownOrQueue,
} from "./teardown-queue";
import {
  destroyStackOn,
  filesDirHasContent,
  migrateWorkloadData,
  startStackOn,
  stopStackOn,
} from "./volume-migration";

type Emit = (level: "info" | "warn" | "error", text: string) => void;

/** `kept`: in a cluster the new server's copy ran last, so it stays and the old one is set aside. */
export type MoveOutcome = "done" | "nothing" | "rolled-back" | "held" | "kept";

export async function completePendingAppMigration(
  appId: string,
  deployedOn: string,
  emit: Emit,
): Promise<MoveOutcome> {
  return withKeyedLock(`app-lifecycle:${appId}`, () =>
    runMigration(appId, deployedOn, emit),
  );
}

/**
 * A cluster App's data comes before its stack starts on the member it moves to, so it never serves an empty copy
 * there (fise, 23 Nov 2026). The caller holds the App's lifecycle lock; anything but a pending move is "nothing".
 */
export async function moveClusterDataBeforeStart(
  appId: string,
  serverId: string,
  deployKey: string,
  emit: Emit,
): Promise<MoveOutcome> {
  const app = await loadAppGraph(appId);
  if (
    !app?.clusterId ||
    !app.migrateFromServerId ||
    app.serverId !== serverId ||
    app.slug !== deployKey
  )
    return "nothing";
  return runMigration(appId, serverId, emit, { beforeStart: true });
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
  opts: { beforeStart?: boolean } = {},
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

  // In a cluster the copy that ran last wins, whichever member is leaving (ADR-0046): read the new one first.
  let there: Ran | null = null;
  if (app.clusterId)
    there = await connectAgent(to)
      .then((c) => readRan(c, slug).finally(() => c.close()))
      .catch(() => null);
  let names: string[];
  let hasStack: boolean;
  let includeFiles = appHasFilesDir(app);
  let leftBehind: string[];
  let here: Ran = { exists: false, lastRanMs: 0, running: false };
  try {
    const old = await connectAgent(from);
    try {
      const stack = await old.readStack(slug);
      here = {
        exists: stack.exists,
        lastRanMs: stack.lastRanMs ?? 0,
        running: stack.running ?? false,
      };
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
    // The member it moved to serves it under its lease, so the silent one is fenced: it stays, and its copy waits.
    if (isUnreachable(e) && there?.running) {
      emit(
        "warn",
        `${app.name}'s data stays on ${toName}, which runs it. ${fromName} does not answer, so its older copy is set aside the next time it does.`,
      );
      return "kept";
    }
    return isUnreachable(e)
      ? hold(app, { fromName, toName, error: e, newStopped: false }, emit)
      : rollback(
          app,
          { fromName, toName, error: e, oldStopped: false, newStopped: false },
          emit,
        );
  }
  if (there && ranLater(there, here) && (names.length > 0 || includeFiles))
    return keepNewer(app, { fromName, toName, names, hasStack }, emit);
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
    // Before its first start a member may hold no stack of it yet.
    if (there?.exists !== false) await stopStackOn(to, slug);
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

  // What the new member held of it is set aside before the copy writes over it, never lost.
  let asideNote = "";
  if (app.clusterId)
    try {
      const copies = await setAsideOn(to, slug, names);
      if (copies.length > 0)
        asideNote = ` What ${toName} held of it was set aside first (${formatBytes(sum(copies))}).`;
    } catch (e) {
      return rollback(
        app,
        {
          fromName,
          toName,
          error: new Error(
            `what ${toName} held of it could not be set aside first: ${errMsg(e)}`,
          ),
          oldStopped,
          newStopped,
        },
        emit,
      );
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
    // Before its first start the deploy that asked for the copy starts it.
    if (!opts.beforeStart) await startStackOn(to, slug);
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
    `${app.name}'s data is on ${toName}.` + asideNote + teardownNote,
  );
  await recordActivity(
    "app",
    `Moved ${app.name}'s data from ${fromName} to ${toName}` +
      (asideNote ? `.${asideNote}` : ""),
    "system",
    appId,
  );
  return "done";
}

const sum = (copies: SetAsideCopy[]) => copies.reduce((n, c) => n + c.bytes, 0);

/** The new member ran it last: its copy stays, and the old member's is set aside on it before the old one goes. */
async function keepNewer(
  app: App,
  ctx: { fromName: string; toName: string; names: string[]; hasStack: boolean },
  emit: Emit,
): Promise<MoveOutcome> {
  const from = app.migrateFromServerId!;
  let copies: SetAsideCopy[];
  try {
    if (ctx.hasStack) await stopStackOn(from, app.slug);
    copies = await setAsideOnto(from, app.serverId, ctx.names, app.slug);
  } catch (e) {
    emit(
      "warn",
      `${app.name}'s data stays on ${ctx.toName}, which ran it after ${ctx.fromName} did. ${ctx.fromName}'s older copy could not be set aside yet (${errMsg(e)}): it stays there, and the next deploy tries again.`,
    );
    return "kept";
  }
  await teardownOrQueue(strayEntry(app, from, ctx.names)).catch(() => {});
  await clearMarker(app.id);
  await clearDataCopyError({ kind: "app", id: app.id });
  const kept =
    copies.length > 0
      ? ` ${ctx.fromName}'s older copy was set aside on ${ctx.toName} (${formatBytes(sum(copies))}), never copied over it.`
      : "";
  emit(
    "info",
    `${app.name}'s data stays on ${ctx.toName}: it ran there after ${ctx.fromName} last did.` +
      kept,
  );
  await recordActivity(
    "app",
    `Kept ${app.name}'s data on ${ctx.toName}, which ran it after ${ctx.fromName} did.` +
      kept,
    "system",
    app.id,
  );
  return "kept";
}

/** Sets what `from` still holds of a cluster App aside where the App runs, Files included. Throws when it cannot. */
async function setAsideOldCopy(
  app: App,
  from: string,
  stopped: () => void = () => {},
): Promise<{ copies: SetAsideCopy[]; names: string[] }> {
  let names: string[];
  let hasStack: boolean;
  const old = await connectAgent(from);
  try {
    const stack = await old.readStack(app.slug);
    hasStack = stack.exists;
    names = await presentVolumes(
      old,
      appMoveVolumeNames(app, stack.exists ? stack.yaml : ""),
    );
    assertSafeVolumeNames(app.slug, names);
  } finally {
    old.close();
  }
  if (hasStack) await stopStackOn(from, app.slug);
  stopped();
  return {
    copies: await setAsideOnto(from, app.serverId, names, app.slug),
    names,
  };
}

const asideSentence = async (app: App, from: string, copies: SetAsideCopy[]) =>
  copies.length > 0
    ? `What ${await serverName(from)} held of ${app.name} was set aside on ${await serverName(app.serverId)} (${formatBytes(sum(copies))}).`
    : `${await serverName(from)} held none of ${app.name}'s data.`;

/**
 * "Deploy anyway" on a cluster App whose move is held: the old member's copy is set aside where the App runs, never
 * deleted. One that does not answer has its removal queued, and Activity says where its copy went once it answers.
 * `stopped` runs once the old copy is stopped, or could not be reached to stop: the new one may start then.
 */
export async function setAsideHeldCopy(
  app: App,
  stopped: () => void = () => {},
): Promise<string> {
  const from = app.migrateFromServerId!;
  try {
    const { copies, names } = await setAsideOldCopy(app, from, stopped);
    await teardownOrQueue(strayEntry(app, from, names)).catch(() => {});
    return await asideSentence(app, from, copies);
  } catch (e) {
    stopped();
    const fromName = await serverName(from);
    if (!isUnreachable(e))
      return `What ${fromName} holds of ${app.name} could not be set aside (${errMsg(e)}), so it stays there.`;
    await enqueueTeardowns([strayEntry(app, from)]);
    return `${fromName} does not answer, so what it holds of ${app.name} stays on it for now: Activity says where it is kept once ${fromName} answers again.`;
  }
}

/**
 * Before a queued teardown of a cluster App's copy on a server it left: that copy is set aside where the App runs.
 * Null when there is nothing to set aside; throws when it cannot be, and the teardown waits.
 */
export async function setAsideBeforeTeardown(entry: {
  serverId: string;
  deployKey: string;
  projectLabel: string;
}): Promise<string | null> {
  const app = await loadAppGraph(entry.projectLabel);
  if (
    !app?.clusterId ||
    app.slug !== entry.deployKey ||
    app.serverId === entry.serverId
  )
    return null;
  const { copies } = await setAsideOldCopy(app, entry.serverId);
  return copies.length > 0
    ? await asideSentence(app, entry.serverId, copies)
    : null;
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
  // Placed back at the leader first, or the old member's lease stops it again as placed elsewhere.
  const cluster = app.clusterId ? await getClusterById(app.clusterId) : null;
  if (cluster)
    await placeAtLeaderFirst(cluster, "app", app.id, from, {
      within: 5_000,
    }).catch(() => false);
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
  const [oldIp, newIp] = await Promise.all([
    serverWildcardIp(leaving),
    serverWildcardIp(arriving),
  ]);
  const rehost = (host: string) =>
    newIp && wildcardEmbeddedIp(host) === oldIp
      ? rehostWildcard(host, newIp)
      : host;
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
    .select({
      previewServerId: appsTable.previewServerId,
      clusterId: appsTable.clusterId,
    })
    .from(appsTable)
    .where(eq(appsTable.id, app.id));
  // On a cluster each preview records the member it runs on, so none is left behind.
  if (row && !row.previewServerId && !row.clusterId)
    await stopPreviewsForServerChange(app.id, serverId).catch(() => {});
}

async function clearMarker(appId: string): Promise<void> {
  await getDb()
    .update(appsTable)
    .set({ migrateFromServerId: null })
    .where(eq(appsTable.id, appId));
}
