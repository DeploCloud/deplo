import "server-only";

import { formatBytes } from "../../utils";
import type { AgentConnection } from "../../infra/agent-client/connection";
import type { SourceCredential } from "../../migration/source";
import type {
  PairedHostMount,
  VolumePair,
} from "../../migration/map/volume-pairing";

import { appendRunItem } from "../migration-import/run-report";
import {
  copyHostPathBetween,
  copyVolumeBetween,
  isCopyAborted,
  type OnBytes,
  type VolumeCopyResult,
} from "../volume-migration";

import { missingVolumeMessage, sharedPathNote } from "./copy-notes";
import { copiedInRun, pathsOverlap, runTwinFor } from "./host-path-clashes";
import type { Landed } from "./landed-targets";
import type { SourceService } from "./source-services";

export interface CopyTally {
  moved: number;
  failed: number;
  empty: number;
  missing: number;
  notCopied: number;
  sourceGone: boolean;
  lost: string[];
}

export function newCopyTally(): CopyTally {
  return {
    moved: 0,
    failed: 0,
    empty: 0,
    missing: 0,
    notCopied: 0,
    sourceGone: false,
    lost: [],
  };
}

export interface CopyContext {
  credential: SourceCredential;
  runId: string;
  panel: string;
  path: string;
  svc: SourceService;
  landed: Landed;
  running: boolean;
  sourceServerId: string;
  source: AgentConnection;
  dest: AgentConnection;
  signal: AbortSignal;
  onBytes?: OnBytes;
  notes: string[];
  tally: CopyTally;
}

type Outcome = "created" | "skipped" | "failed" | "manual" | "unsupported";

async function record(
  ctx: CopyContext,
  sourceName: string,
  outcome: Outcome,
  message: string,
): Promise<void> {
  await appendRunItem(ctx.runId, ctx.panel, {
    path: ctx.path,
    sourceKind: "volume",
    sourceName,
    outcome,
    targetKind: ctx.landed.targetKind,
    targetId: ctx.landed.targetId,
    message,
  });
}

async function recordEmpty(
  ctx: CopyContext,
  sourceName: string,
  mountPath: string,
  copied: VolumeCopyResult,
  leftAsIs: string,
): Promise<void> {
  ctx.tally.empty++;
  if (copied.missing) ctx.tally.missing++;
  if (copied.missing && ctx.running) {
    ctx.tally.notCopied++;
    ctx.tally.lost.push(
      `${sourceName} (${mountPath}): not on the machine ${ctx.panel} says ${ctx.svc.name} runs on`,
    );
  }
  await record(
    ctx,
    sourceName,
    copied.missing && ctx.running ? "failed" : "skipped",
    copied.missing
      ? missingVolumeMessage(sourceName, ctx.svc.name, ctx.running)
      : leftAsIs,
  );
}

async function recordCopied(
  ctx: CopyContext,
  sourceName: string,
  message: string,
): Promise<void> {
  ctx.tally.moved++;
  await record(ctx, sourceName, "created", message);
}

async function recordFailure(
  ctx: CopyContext,
  sourceName: string,
  mountPath: string,
  e: unknown,
): Promise<void> {
  if (isCopyAborted(e)) throw e;
  ctx.tally.failed++;
  if (isHostGone(e)) ctx.tally.sourceGone = true;
  const message = e instanceof Error ? e.message : "the copy failed";
  ctx.notes.push(`${sourceName}: ${message}`);
  ctx.tally.lost.push(`${sourceName} (${mountPath}): ${message}`);
  await record(ctx, sourceName, "failed", message);
}

function isHostGone(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === 14) return true;
  return e instanceof Error && /\b14 UNAVAILABLE\b/.test(e.message);
}

export async function copyPairedVolumes(
  ctx: CopyContext,
  pairs: VolumePair[],
): Promise<void> {
  for (const pair of pairs) {
    try {
      const copied = await copyVolumeBetween(
        ctx.source,
        ctx.dest,
        pair.sourceVolume,
        pair.targetVolume,
        ctx.onBytes,
        ctx.signal,
      );
      if (copied.empty) {
        await recordEmpty(
          ctx,
          pair.sourceVolume,
          pair.mountPath,
          copied,
          `${pair.sourceVolume} holds nothing on {panel}, so ${pair.targetVolume} (${pair.mountPath}) was left as it is.`,
        );
        continue;
      }
      await recordCopied(
        ctx,
        pair.sourceVolume,
        `Copied ${formatBytes(copied.bytes)} (compressed) into ${pair.targetVolume} (${pair.mountPath}).` +
          (pair.note ? ` ${pair.note}` : "") +
          (copied.dropped ? ` ${copied.dropped}` : ""),
      );
    } catch (e) {
      await recordFailure(ctx, pair.sourceVolume, pair.mountPath, e);
    }
  }
}

export async function copyBindMounts(
  ctx: CopyContext,
  binds: PairedHostMount[],
  bindOwners: { appId: string; name: string; path: string }[],
  mayCopyHostPaths: boolean,
): Promise<void> {
  for (const bind of binds) {
    if (!mayCopyHostPaths && !bind.stackRelative) {
      await record(
        ctx,
        bind.sourcePath,
        "manual",
        `${bind.sourcePath} is a host directory (mounted at ${bind.mountPath}). Copying one needs instance admin and the host-volumes permission, so its contents did not come over.`,
      );
      continue;
    }
    if (
      ctx.sourceServerId === ctx.landed.targetServerId &&
      bind.sourcePath === bind.targetPath
    ) {
      await record(
        ctx,
        bind.sourcePath,
        "skipped",
        `${bind.sourcePath} is already on this machine at the same path - nothing to copy.`,
      );
      continue;
    }
    const clash = bindOwners.find((o) => pathsOverlap(o.path, bind.targetPath));
    if (
      clash &&
      (await runTwinFor(ctx.credential, ctx.runId, ctx.svc, clash.appId))
    ) {
      if (await copiedInRun(ctx.runId, bind.targetPath)) {
        await record(
          ctx,
          bind.sourcePath,
          "skipped",
          `${bind.targetPath} is shared with ${clash.name} and was already copied for it in this run.`,
        );
        continue;
      }
    } else if (clash) {
      ctx.tally.notCopied++;
      const message = sharedPathNote(clash, bind.targetPath);
      ctx.notes.push(message);
      ctx.tally.lost.push(`${bind.sourcePath} (${bind.mountPath}): ${message}`);
      await record(ctx, bind.sourcePath, "manual", message);
      continue;
    }
    try {
      const copied = await copyHostPathBetween(
        ctx.source,
        ctx.dest,
        bind.sourcePath,
        bind.targetPath,
        ctx.onBytes,
        ctx.signal,
      );
      if (copied.empty) {
        await recordEmpty(
          ctx,
          bind.sourcePath,
          bind.mountPath,
          copied,
          `${bind.sourcePath} is empty on {panel}, so ${bind.targetPath} was left as it is.`,
        );
        continue;
      }
      await recordCopied(
        ctx,
        bind.sourcePath,
        `Copied ${formatBytes(copied.bytes)} (compressed) into ${bind.targetPath} (${bind.mountPath}), a host ${copied.file ? "file" : "directory"}.` +
          (copied.dropped ? ` ${copied.dropped}` : ""),
      );
    } catch (e) {
      await recordFailure(ctx, bind.sourcePath, bind.mountPath, e);
    }
  }
}
