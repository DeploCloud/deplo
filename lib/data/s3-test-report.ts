import type { LogLevel, S3Provider } from "../types";

/**
 * The "Test connection" report for an S3 destination: what deplo probed, in
 * order, and what came back — the debug output behind the badge.
 *
 * WHY THIS EXISTS. Testing a destination used to be a black box that always
 * reported success: the mutation returned the destination regardless of the
 * agent's verdict, so the UI toasted "connection verified" over a probe that had
 * just failed, and a red badge could never say why. The verdict now travels with
 * the reason, and this module turns it into something readable.
 *
 * WHAT IS REAL AND WHAT IS DERIVED — the honesty rule for this file. The agent's
 * `S3Check` RPC returns exactly `{ ok, error }` (see deplo-agent
 * internal/s3client/s3client.go `Check`), so:
 *  - `error` is the agent's VERBATIM message and is never rewritten here;
 *  - the step sequence is DERIVED. It mirrors, one-for-one, the fixed sequence
 *    `Check` performs — build client (with its SSRF guard) → BucketExists →
 *    PutObject probe → RemoveObject — and the step it stopped at is read off the
 *    message prefixes that same function produces. It is not a transcript the
 *    agent sent us, and the UI says so.
 * Keep {@link classifyFailedStep} in sync with the agent's messages: a prefix it
 * no longer recognises degrades to "the probe failed, here is the output",
 * never to a wrong step being blamed.
 *
 * Pure and dependency-free (no db, no agent, no session) so the whole
 * presentation is unit-testable from a `{ ok, error }` pair.
 */

/** One step of the fixed probe sequence the agent's `Check` performs. */
export type S3TestStepKey = "agent" | "client" | "bucket" | "write" | "cleanup";

export type S3TestStepStatus = "passed" | "failed" | "skipped";

export interface S3TestStep {
  key: S3TestStepKey;
  /** Short human label ("Check the bucket exists"). */
  label: string;
  /** What the step actually ran, with the real coordinates. */
  detail: string;
  status: S3TestStepStatus;
}

/** A line of the rendered probe log (same shape the log consoles render). */
export interface S3TestLogLine {
  level: LogLevel;
  text: string;
}

export interface S3TestReport {
  /** True only when the bucket was reachable AND writable. */
  ok: boolean;
  /** The agent's verbatim failure message; "" when it passed. */
  error: string;
  /** ISO timestamp the probe started. */
  startedAt: string;
  /** Probe duration in ms. */
  durationMs: number;
  /** Display name of the server whose agent served the probe; "" if none did. */
  serverName: string;
  /** The fixed probe sequence, with the outcome of each step. */
  steps: S3TestStep[];
  /** The probe log, ready to render. */
  lines: S3TestLogLine[];
  /** Shell commands that reproduce the same three S3 calls by hand. */
  command: string;
  /** True when there is no verdict yet (never tested). */
  never: boolean;
}

/** The reserved key the agent writes and removes to prove the bucket is writable. */
export const PROBE_KEY = ".deplo-s3check";

/**
 * The destination coordinates the report needs. Deliberately NOT the DTO: this
 * module must never see a decrypted credential, and taking the exact fields it
 * prints makes that visible at the call site.
 */
export interface S3TestTarget {
  name: string;
  provider: S3Provider;
  /** As stored — may or may not carry a scheme. */
  endpoint: string;
  region: string;
  bucket: string;
}

/**
 * Split a stored endpoint the way the agent's minio client does: strip the
 * scheme, derive TLS from it, and default to TLS when no scheme is given (the
 * safe default for a public S3). Mirrors `s3client.New`.
 */
export function splitEndpoint(endpoint: string): { host: string; secure: boolean } {
  const raw = endpoint.trim();
  if (raw.startsWith("https://"))
    return { host: raw.slice("https://".length).replace(/\/+$/, ""), secure: true };
  if (raw.startsWith("http://"))
    return { host: raw.slice("http://".length).replace(/\/+$/, ""), secure: false };
  return { host: raw.replace(/\/+$/, ""), secure: true };
}

/** The full URL form of a stored endpoint (scheme always explicit). */
export function endpointUrl(endpoint: string): string {
  const { host, secure } = splitEndpoint(endpoint);
  return `${secure ? "https" : "http"}://${host}`;
}

/**
 * Bucket addressing style, mirroring `pathStyleFor` in s3.ts: AWS is
 * virtual-host, every S3-compatible store gets path-style.
 */
function pathStyle(provider: S3Provider): boolean {
  return provider !== "aws";
}

/**
 * Which step a verdict stopped at, read off the agent's own message prefixes
 * (deplo-agent internal/s3client/s3client.go):
 *  - `s3: empty endpoint` / `cannot resolve endpoint host` / `SSRF guard`
 *    ⇒ the client never got built.
 *  - `reach bucket "x": …` / `bucket "x" does not exist …` ⇒ BucketExists failed.
 *  - `write probe to bucket "x": …` ⇒ the PutObject probe failed (read-only key).
 * Anything unrecognised blames NO step (null): the log still shows the verbatim
 * output, which beats pointing at the wrong operation.
 */
export function classifyFailedStep(error: string): S3TestStepKey | null {
  const e = error.toLowerCase();
  if (!e.trim()) return null;
  if (
    e.includes("empty endpoint") ||
    e.includes("cannot resolve endpoint host") ||
    e.includes("ssrf guard") ||
    e.includes("refusing to connect")
  )
    return "client";
  if (e.includes("write probe to bucket")) return "write";
  if (e.includes("reach bucket") || e.includes("does not exist")) return "bucket";
  return null;
}

/**
 * Build the report for a completed probe. `serverName` empty ⇒ no agent served
 * it (the "agent" step is what failed); `agentAttempts` are the servers deplo
 * tried and skipped on the way, which is the difference between "your bucket is
 * wrong" and "no host could even run the check".
 */
export function buildS3TestReport(opts: {
  target: S3TestTarget;
  ok: boolean;
  error: string;
  startedAt: string;
  durationMs: number;
  serverName: string;
  /** `<server> — <why it was skipped>`, in the order they were tried. */
  agentAttempts?: string[];
}): S3TestReport {
  const { target, ok, error, startedAt, durationMs, serverName } = opts;
  const attempts = opts.agentAttempts ?? [];
  const { host, secure } = splitEndpoint(target.endpoint);
  const style = pathStyle(target.provider) ? "path" : "virtual-host";
  const servedBy = serverName || "";

  // Which step to blame. No agent served the probe ⇒ it never reached S3 at all.
  const failedStep: S3TestStepKey | null = ok
    ? null
    : servedBy
      ? classifyFailedStep(error)
      : "agent";

  const ORDER: S3TestStepKey[] = ["agent", "client", "bucket", "write", "cleanup"];
  const LABEL: Record<S3TestStepKey, string> = {
    agent: "Pick a server to run the check from",
    client: "Open a connection to the endpoint",
    bucket: "Check the bucket exists",
    write: "Write a probe file to the bucket",
    cleanup: "Remove the probe file",
  };
  const DETAIL: Record<S3TestStepKey, string> = {
    agent: servedBy
      ? `served by ${servedBy}`
      : "no server with a backup-capable agent answered",
    client: `${secure ? "https" : "http"}://${host} · region ${target.region} · ${style} addressing`,
    bucket: `HeadBucket ${target.bucket}`,
    write: `PutObject ${target.bucket}/${PROBE_KEY} (0 bytes)`,
    cleanup: `RemoveObject ${target.bucket}/${PROBE_KEY} (best effort — a failure here is ignored)`,
  };
  const step = (key: S3TestStepKey, status: S3TestStepStatus): S3TestStep => ({
    key,
    label: LABEL[key],
    detail: DETAIL[key],
    status,
  });

  // Everything before the failing step ran; everything after never got to. An
  // UNATTRIBUTABLE failure (a message no prefix matches) lists only the step we
  // can actually vouch for — the agent answered — rather than mislabelling the
  // rest as "not reached", which may well be false. The verbatim output carries
  // the rest of the story.
  const failedAt = failedStep ? ORDER.indexOf(failedStep) : -1;
  const steps: S3TestStep[] = ok
    ? ORDER.map((key) => step(key, "passed"))
    : failedAt === -1
      ? [step("agent", "passed")]
      : ORDER.map((key, i) =>
          step(key, i < failedAt ? "passed" : i === failedAt ? "failed" : "skipped"),
        );

  const lines: S3TestLogLine[] = [];
  lines.push({
    level: "info",
    text: `Testing "${target.name}" — bucket ${target.bucket} at ${endpointUrl(target.endpoint)}`,
  });
  for (const a of attempts) lines.push({ level: "warn", text: `skipped ${a}` });
  for (const step of steps) {
    if (step.status === "skipped") {
      lines.push({ level: "debug", text: `${step.label} — not reached (${step.detail})` });
      continue;
    }
    lines.push({ level: "command", text: step.detail });
    lines.push({
      level: step.status === "passed" ? "success" : "error",
      text:
        step.status === "passed"
          ? `${step.label} — ok`
          : `${step.label} — failed`,
    });
  }
  if (!ok && error) lines.push({ level: "error", text: error });
  lines.push({
    level: ok ? "success" : "error",
    text: ok
      ? `Bucket is reachable and writable (${durationMs} ms)`
      : `Test failed after ${durationMs} ms`,
  });

  return {
    ok,
    error,
    startedAt,
    durationMs,
    serverName: servedBy,
    steps,
    lines,
    command: reproduceCommand(target),
    never: false,
  };
}

/** The "never tested yet" report, so the dialog has something honest to show. */
export function emptyS3TestReport(target: S3TestTarget): S3TestReport {
  return {
    ok: false,
    error: "",
    startedAt: "",
    durationMs: 0,
    serverName: "",
    steps: [],
    lines: [
      {
        level: "info",
        text: `"${target.name}" has not been tested yet. Run the test to probe the bucket.`,
      },
    ],
    command: reproduceCommand(target),
    never: true,
  };
}

/**
 * The same three S3 calls, as commands an operator can paste into a shell to see
 * the provider's raw answer for themselves.
 *
 * deplo does NOT shell out — the agent performs them in-process with minio-go
 * (one Go binary, no aws CLI on the host) — so this is billed in the UI as
 * "reproduce it yourself", not as "the command we ran". Credentials are
 * placeholders on purpose: a stored secret is write-only in deplo and has no
 * reveal path, and this block must not become one.
 */
export function reproduceCommand(target: S3TestTarget): string {
  const url = endpointUrl(target.endpoint);
  const common = `--endpoint-url ${url} --region ${target.region || "auto"}`;
  const styleNote = pathStyle(target.provider)
    ? `\n# ${target.provider} needs path-style addressing (deplo sets it for you):\naws configure set default.s3.addressing_style path`
    : "";
  return [
    `# deplo runs this check inside the server's agent (Go, minio-go) — no CLI needed.`,
    `# These are the same three calls, to reproduce the provider's answer by hand.`,
    ``,
    `export AWS_ACCESS_KEY_ID='<access key>'      # deplo never reveals a stored secret`,
    `export AWS_SECRET_ACCESS_KEY='<secret key>'`,
    `export AWS_EC2_METADATA_DISABLED=true${styleNote}`,
    ``,
    `# 1. the bucket exists and these credentials can see it`,
    `aws ${common} s3api head-bucket --bucket ${target.bucket}`,
    ``,
    `# 2. the credentials can WRITE (a read-only key fails here)`,
    `aws ${common} s3api put-object --bucket ${target.bucket} --key ${PROBE_KEY}`,
    ``,
    `# 3. clean the probe file up again`,
    `aws ${common} s3api delete-object --bucket ${target.bucket} --key ${PROBE_KEY}`,
  ].join("\n");
}
