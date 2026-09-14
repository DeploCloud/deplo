import "server-only";

import { getCurrentUser } from "../../auth/current-user";
import { requireMembership } from "../../membership";
import { recordActivity } from "../activity";
import { dispatchAlert } from "../../notify/dispatch";
import { setAppStatus } from "../apps/lifecycle";
import { mapBackupUnsupported } from "../../infra/agent-client/errors";
import { openUploadRestore } from "../backup-transport";
import { SNIFF_HEAD_BYTES, sniffArtifact } from "../../backups/artifact-sniff";
import { requireBackupCapability } from "./target-access";
import { resolveTarget, type ResolvedTarget } from "./target-descriptor";
import type { RestoreEvent } from "../../agent/gen/agent";
import type { BackupTargetKind } from "../../types/backup";

// Targets with an upload restore streaming into them right now. Two at once would
// untar into the same volumes while the other wipes them; the second is refused.
const uploadRestoresInFlight = new Set<string>();

// prepareUploadRestore - restore an app or a database from an artifact the operator
// UPLOADS, the only recovery path that survives losing the control plane. Everything
// that can refuse refuses BEFORE the agent is dialed, and the bytes never touch a disk.
export async function prepareUploadRestore(input: {
  kind: BackupTargetKind;
  targetId: string;
  // The destination's recovery key. Never stored, never logged, never written
  // to the Activity trail.
  recoveryKey: string;
  body: ReadableStream<Uint8Array>;
}): Promise<{
  events: AsyncGenerator<RestoreEvent, void, unknown>;
  abandon: () => Promise<void>;
}> {
  const { membership } = await requireMembership();
  const teamId = membership.teamId;
  // Resolved NOW, while the request context still exists: the generator below
  // outlives the route handler, and `getCurrentUser()` reads cookies.
  const user = (await getCurrentUser())!;
  const appId = input.kind === "app" ? input.targetId : null;
  const databaseId = input.kind === "database" ? input.targetId : null;

  // Same gate as restoring a recorded run, and for the same reason: this
  // overwrites live data. For an app it also carries the folder grant.
  await requireBackupCapability(
    { targetKind: input.kind, appId },
    "restore_backups",
  );

  const noun = input.kind === "app" ? "app" : "database";
  const lockKey = `${teamId} ${input.targetId}`;
  if (uploadRestoresInFlight.has(lockKey))
    throw new Error(
      `A restore is already running for this ${noun} - wait for it to finish`,
    );
  uploadRestoresInFlight.add(lockKey);

  let opened: Awaited<ReturnType<typeof openUploadRestore>> | null = null;
  let target: ResolvedTarget;
  try {
    // The artifact is judged FIRST, before the target is resolved: that resolution
    // dials the owning agent, and a file that was never a backup should cost
    // nobody a round trip, let alone reach a host.
    const reader = input.body.getReader();
    const head = await readUploadHead(reader);
    const { encrypted } = await sniffArtifact(head, {
      kind: input.kind,
      recoveryKey: input.recoveryKey,
    });

    target = await resolveTarget(teamId, input.kind, databaseId, appId);

    const blocked = uploadRestoreRefusal(target);
    if (blocked) throw new Error(blocked);

    const uploaded = uploadChunks(head, reader);
    const wrapped = encrypted
      ? { ageIdentity: input.recoveryKey.trim(), chunks: uploaded }
      : await wrapPlaintextUpload(uploaded);

    opened = await openUploadRestore(
      target,
      wrapped.ageIdentity,
      wrapped.chunks,
    );
    // Only once the agent has the request: a dial that fails must not leave an
    // app parked on "restoring" with nothing running to move it off.
    if (target.appId) await setAppStatus(target.appId, "restoring");
  } catch (e) {
    opened?.close();
    uploadRestoresInFlight.delete(lockKey);
    throw mapBackupUnsupported(e);
  }

  const agent = opened;
  const resolved = target;
  const INTERRUPTED = "the restore was interrupted before it finished";

  // Deliberately NOT inside the generator's `finally`: that only runs for a
  // generator somebody pulled, and the ending most worth recording - the browser
  // vanishing - is the one that may never pull.
  let closed = false;
  async function finish(problem: string | null): Promise<void> {
    if (closed) return;
    closed = true;
    // An app left on "restoring" because nobody stayed to watch would never move
    // off it again.
    if (resolved.appId)
      await setAppStatus(resolved.appId, problem ? "error" : "active");
    await recordActivity(
      "backup",
      problem
        ? `Restore of ${resolved.label} from an uploaded file failed: ${problem}`
        : `Restored ${resolved.label} from an uploaded file`,
      user.name,
      resolved.appId,
      teamId,
      null,
      resolved.databaseId,
    );
    dispatchAlert({
      teamId,
      key: problem ? "restore_failed" : "restore_succeeded",
      title: problem
        ? `Restore of ${resolved.label} failed`
        : `Restored ${resolved.label}`,
      body: problem ?? "The data is back in place.",
      path: "/storage",
    });
    agent.close();
    uploadRestoresInFlight.delete(lockKey);
  }

  async function* relay(): AsyncGenerator<RestoreEvent, void, unknown> {
    let failure: string | null = null;
    let settled = false;
    try {
      try {
        for await (const ev of agent.events) {
          if (ev.result) {
            settled = true;
            if (!ev.result.ok)
              failure =
                ev.result.error || "the agent reported a failed restore";
          }
          yield ev;
        }
        if (!settled) failure = "the agent ended the restore without a result";
      } catch (e) {
        failure = (mapBackupUnsupported(e) as Error).message;
      }
      // Covers the endings the agent never got to report (a dropped connection),
      // so the browser always reads a verdict as the last line.
      if (failure && !settled) yield { result: { ok: false, error: failure } };
    } finally {
      await finish(failure ?? (settled ? null : INTERRUPTED));
    }
  }

  return { events: relay(), abandon: () => finish(INTERRUPTED) };
}

// uploadRestoreRefusal - why an UPLOADED artifact must not be restored into this
// target, or null. NOT the security boundary (that is `untrusted_config`): an app
// never deployed has no stack to land in, and its empty compose is the test.
export function uploadRestoreRefusal(target: {
  kind: BackupTargetKind;
  project?: { composeYaml: string };
}): string | null {
  if (target.kind !== "app") return null;
  if (target.project?.composeYaml) return null;
  return (
    "This app has never been deployed on its server, so there is no stack to " +
    "restore into. Deploy it once, then restore the backup over it."
  );
}

// readUploadHead - read at most SNIFF_HEAD_BYTES from the upload, leaving the
// reader positioned for the rest. Short reads are normal.
async function readUploadHead(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Buffer> {
  const parts: Buffer[] = [];
  let total = 0;
  while (total < SNIFF_HEAD_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(Buffer.from(value));
    total += value.length;
  }
  return Buffer.concat(parts);
}

// uploadChunks - the upload as the agent pump wants it: the sniffed head, then the remainder.
async function* uploadChunks(
  head: Buffer,
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<Buffer, void, unknown> {
  try {
    if (head.length > 0) yield head;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield Buffer.from(value);
    }
  } finally {
    // Whoever stops reading stops the upload. A restore that fails early (or an
    // agent that drops) otherwise leaves the browser pushing gigabytes into a
    // socket nobody drains; cancelling tears the request body down instead.
    void reader.cancel().catch(() => {});
  }
}

// wrapPlaintextUpload - wrap a plaintext upload for an agent that only restores
// encrypted artifacts. The keypair lives for this request only - the shape
// RestoreFrom insists on, not a secret to keep.
async function wrapPlaintextUpload(source: AsyncIterable<Buffer>): Promise<{
  ageIdentity: string;
  chunks: AsyncIterable<Buffer>;
}> {
  const age = await import("age-encryption");
  const identity = await age.generateX25519Identity();
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(await age.identityToRecipient(identity));
  const iterator = source[Symbol.asyncIterator]();
  const encrypted = await encrypter.encrypt(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        const next = await iterator.next();
        if (next.done) controller.close();
        else controller.enqueue(next.value);
      },
    }),
  );
  return { ageIdentity: identity, chunks: streamBuffers(encrypted) };
}

async function* streamBuffers(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Buffer, void, unknown> {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield Buffer.from(value);
  }
}
