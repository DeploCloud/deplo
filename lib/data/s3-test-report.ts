import type { DestinationKind, S3Provider } from "../types/backup";
import type { LogLevel } from "../types/deployment";

// S3TestStepKey - one step of the fixed probe sequence the agent performs.
export type S3TestStepKey =
  "agent" | "client" | "bucket" | "root" | "write" | "cleanup";

export type S3TestStepStatus = "passed" | "failed" | "skipped";

export interface S3TestStep {
  key: S3TestStepKey;
  label: string;
  detail: string;
  status: S3TestStepStatus;
}

// S3TestLogLine - a line of the rendered probe log.
export interface S3TestLogLine {
  level: LogLevel;
  text: string;
}

export interface S3TestReport {
  ok: boolean;
  error: string;
  startedAt: string;
  durationMs: number;
  serverName: string;
  steps: S3TestStep[];
  lines: S3TestLogLine[];
  command: string;
  never: boolean;
}

// PROBE_KEY - the key the agent writes and removes to prove the bucket is writable.
export const PROBE_KEY = ".deplo-s3check";

// STORE_PROBE_FILE - its folder equivalent (deplo-agent backup_store.go `storeCheck`).
export const STORE_PROBE_FILE = ".deplo-store-check";

// S3TestTarget - the report's coordinates, never the DTO: this module must not see a credential.
export interface S3TestTarget {
  name: string;
  kind: DestinationKind;
  provider: S3Provider;
  endpoint: string;
  region: string;
  bucket: string;
  path: string;
}

// splitEndpoint - strips the scheme and derives TLS, defaulting to TLS; mirrors `s3client.New`.
export function splitEndpoint(endpoint: string): {
  host: string;
  secure: boolean;
} {
  const raw = endpoint.trim();
  if (raw.startsWith("https://"))
    return {
      host: raw.slice("https://".length).replace(/\/+$/, ""),
      secure: true,
    };
  if (raw.startsWith("http://"))
    return {
      host: raw.slice("http://".length).replace(/\/+$/, ""),
      secure: false,
    };
  return { host: raw.replace(/\/+$/, ""), secure: true };
}

// endpointUrl - the full URL form of a stored endpoint, scheme always explicit.
export function endpointUrl(endpoint: string): string {
  const { host, secure } = splitEndpoint(endpoint);
  return `${secure ? "https" : "http"}://${host}`;
}

// Mirrors `pathStyleFor` in s3.ts: AWS is virtual-host, every other store path-style.
function pathStyle(provider: S3Provider): boolean {
  return provider !== "aws";
}

// classifyFailedStep - which step a verdict stopped at, read off the agent's message prefixes.
export function classifyFailedStep(
  error: string,
  kind: DestinationKind = "s3",
): S3TestStepKey | null {
  const e = error.toLowerCase();
  if (!e.trim()) return null;
  if (kind === "server") {
    // deplo-agent backup_store.go: only `storeCheck`'s own probe write says "cannot write to".
    if (e.startsWith("cannot write to ")) return "write";
    if (e.includes("backup store")) return "root";
    return null;
  }
  if (
    e.includes("empty endpoint") ||
    e.includes("cannot resolve endpoint host") ||
    e.includes("ssrf guard") ||
    e.includes("refusing to connect")
  )
    return "client";
  if (e.includes("write probe to bucket")) return "write";
  if (e.includes("reach bucket") || e.includes("does not exist"))
    return "bucket";
  return null;
}

// buildS3TestReport - the report for a completed probe.
export function buildS3TestReport(opts: {
  target: S3TestTarget;
  ok: boolean;
  error: string;
  startedAt: string;
  durationMs: number;
  serverName: string;
  agentAttempts?: string[];
}): S3TestReport {
  const { target, ok, error, startedAt, durationMs, serverName } = opts;
  const attempts = opts.agentAttempts ?? [];
  const { host, secure } = splitEndpoint(target.endpoint);
  const style = pathStyle(target.provider) ? "path" : "virtual-host";
  const servedBy = serverName || "";
  const isServer = target.kind === "server";
  const folder = target.path || "deplo's own backup folder on that server";
  const probeFile = target.path
    ? `${target.path}/${STORE_PROBE_FILE}`
    : STORE_PROBE_FILE;

  const failedStep: S3TestStepKey | null = ok
    ? null
    : servedBy
      ? classifyFailedStep(error, target.kind)
      : "agent";

  const ORDER: S3TestStepKey[] = isServer
    ? ["agent", "root", "write", "cleanup"]
    : ["agent", "client", "bucket", "write", "cleanup"];
  const LABEL: Record<S3TestStepKey, string> = {
    agent: isServer
      ? "Reach the server"
      : "Pick a server to run the check from",
    client: "Open a connection to the endpoint",
    bucket: "Check the bucket exists",
    root: "Open the backup folder",
    write: isServer
      ? "Write a probe file to the folder"
      : "Write a probe file to the bucket",
    cleanup: "Remove the probe file",
  };
  const DETAIL: Record<S3TestStepKey, string> = {
    agent: servedBy
      ? `served by ${servedBy}`
      : isServer
        ? "the server's agent did not run the check (unreachable, or too old for it)"
        : "no server with a backup-capable agent answered",
    client: `${secure ? "https" : "http"}://${host} · region ${target.region} · ${style} addressing`,
    bucket: `HeadBucket ${target.bucket}`,
    root: target.path
      ? `${target.path} (created and marked for Deplo if missing)`
      : "deplo's own backup folder on that server (created on the first test)",
    write: isServer
      ? `${probeFile} (2 bytes) - a read-only disk fails here`
      : `PutObject ${target.bucket}/${PROBE_KEY} (0 bytes)`,
    cleanup: isServer
      ? `${probeFile}, then sweep any leftover .partial artifacts`
      : `RemoveObject ${target.bucket}/${PROBE_KEY} (best effort - a failure here is ignored)`,
  };
  const step = (key: S3TestStepKey, status: S3TestStepStatus): S3TestStep => ({
    key,
    label: LABEL[key],
    detail: DETAIL[key],
    status,
  });

  const failedAt = failedStep ? ORDER.indexOf(failedStep) : -1;
  const steps: S3TestStep[] = ok
    ? ORDER.map((key) => step(key, "passed"))
    : failedAt === -1
      ? [step("agent", "passed")]
      : ORDER.map((key, i) =>
          step(
            key,
            i < failedAt ? "passed" : i === failedAt ? "failed" : "skipped",
          ),
        );

  const lines: S3TestLogLine[] = [];
  lines.push({
    level: "info",
    text: isServer
      ? `Testing "${target.name}" - ${folder}${servedBy ? ` on ${servedBy}` : ""}`
      : `Testing "${target.name}" - bucket ${target.bucket} at ${endpointUrl(target.endpoint)}`,
  });
  for (const a of attempts) lines.push({ level: "warn", text: `skipped ${a}` });
  for (const step of steps) {
    if (step.status === "skipped") {
      lines.push({
        level: "debug",
        text: `${step.label}, not reached (${step.detail})`,
      });
      continue;
    }
    lines.push({ level: "command", text: step.detail });
    lines.push({
      level: step.status === "passed" ? "success" : "error",
      text:
        step.status === "passed"
          ? `${step.label} - ok`
          : `${step.label} - failed`,
    });
  }
  if (!ok && error) lines.push({ level: "error", text: error });
  lines.push({
    level: ok ? "success" : "error",
    text: ok
      ? isServer
        ? `Folder is ready and writable (${durationMs} ms)`
        : `Bucket is reachable and writable (${durationMs} ms)`
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

// emptyS3TestReport - the "never tested yet" report, so the dialog has something to show.
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
        text:
          target.kind === "server"
            ? `"${target.name}" has not been tested yet. Run the test to set up the backup folder and check it is writable.`
            : `"${target.name}" has not been tested yet. Run the test to probe the bucket.`,
      },
    ],
    command: reproduceCommand(target),
    never: true,
  };
}

// reproduceCommand - the same calls, as commands an operator can paste into a shell.
export function reproduceCommand(target: S3TestTarget): string {
  if (target.kind === "server") return reproduceStoreCommand(target);
  const url = endpointUrl(target.endpoint);
  // Quoted even though Deplo validates on the way in: either guard alone is one refactor from being the only one.
  const common = `--endpoint-url ${shellQuote(url)} --region ${shellQuote(target.region || "auto")}`;
  const bucket = shellQuote(target.bucket);
  const styleNote = pathStyle(target.provider)
    ? `\n# ${target.provider} needs path-style addressing (Deplo sets it for you):\naws configure set default.s3.addressing_style path`
    : "";
  return [
    `# Deplo runs this check inside the server's agent (Go, minio-go) - no CLI needed.`,
    `# These are the same three calls, to reproduce the provider's answer by hand.`,
    ``,
    `export AWS_ACCESS_KEY_ID='<access key>'      # Deplo never reveals a stored secret`,
    `export AWS_SECRET_ACCESS_KEY='<secret key>'`,
    `export AWS_EC2_METADATA_DISABLED=true${styleNote}`,
    ``,
    `# 1. the bucket exists and these credentials can see it`,
    `aws ${common} s3api head-bucket --bucket ${bucket}`,
    ``,
    `# 2. the credentials can WRITE (a read-only key fails here)`,
    `aws ${common} s3api put-object --bucket ${bucket} --key ${PROBE_KEY}`,
    ``,
    `# 3. clean the probe file up again`,
    `aws ${common} s3api delete-object --bucket ${bucket} --key ${PROBE_KEY}`,
  ].join("\n");
}

function reproduceStoreCommand(target: S3TestTarget): string {
  const known = target.path !== "";
  return [
    `# Deplo runs this check inside the server's agent (Go) - nothing runs on a shell.`,
    `# These are the same operations, to see the disk's answer for yourself.`,
    ``,
    known
      ? `FOLDER=${shellQuote(target.path)}`
      : `FOLDER=            # run the test once - Deplo then shows the folder on the card`,
    ``,
    `# 1. the folder is there, and Deplo has marked it as its own`,
    `ls -la "$FOLDER" "$FOLDER/.deplo-backups"`,
    ``,
    `# 2. it is writable (a read-only mount or a full disk fails here)`,
    `touch "$FOLDER/${STORE_PROBE_FILE}" && rm -f "$FOLDER/${STORE_PROBE_FILE}"`,
    ``,
    `# 3. the headroom Deplo shows on the card`,
    `df -h "$FOLDER"`,
  ].join("\n");
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
