import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildS3TestReport,
  classifyFailedStep,
  emptyS3TestReport,
  endpointUrl,
  reproduceCommand,
  splitEndpoint,
  PROBE_KEY,
  type S3TestTarget,
} from "./s3-test-report";

/**
 * The connection-test report. A prefix we don't recognise must blame NO step
 * rather than the wrong one, and no report may ever claim a step passed after the
 * one that failed.
 */

const target: S3TestTarget = {
  name: "Backups",
  kind: "s3",
  provider: "minio",
  endpoint: "https://s3.example.com",
  region: "eu-central-1",
  bucket: "deplo-backups",
  path: "",
};

/** The other destination shape: a folder on a server (ADR-0019). */
const serverTarget: S3TestTarget = {
  name: "This server",
  kind: "server",
  provider: "other",
  endpoint: "eu-main-1 · /var/lib/deplo/backups",
  region: "",
  bucket: "",
  path: "/var/lib/deplo/backups",
};

const report = (over: Partial<Parameters<typeof buildS3TestReport>[0]> = {}) =>
  buildS3TestReport({
    target,
    ok: true,
    error: "",
    startedAt: "2026-07-29T10:00:00.000Z",
    durationMs: 412,
    serverName: "eu-main-1",
    ...over,
  });

const statusOf = (r: ReturnType<typeof buildS3TestReport>, key: string) =>
  r.steps.find((s) => s.key === key)?.status;

/* ---- endpoint parsing (mirrors s3client.New) ------------------------ */

test("splitEndpoint derives TLS from the scheme and defaults to https", () => {
  assert.deepEqual(splitEndpoint("https://s3.example.com"), {
    host: "s3.example.com",
    secure: true,
  });
  assert.deepEqual(splitEndpoint("http://minio.local:9000"), {
    host: "minio.local:9000",
    secure: false,
  });
  // No scheme ⇒ TLS, the agent's safe default for a public S3.
  assert.deepEqual(splitEndpoint("s3.example.com"), {
    host: "s3.example.com",
    secure: true,
  });
  // A trailing slash is not part of the host.
  assert.equal(splitEndpoint("https://s3.example.com/").host, "s3.example.com");
});

test("endpointUrl always spells the scheme out", () => {
  assert.equal(endpointUrl("s3.example.com"), "https://s3.example.com");
  assert.equal(
    endpointUrl("http://minio.local:9000"),
    "http://minio.local:9000",
  );
});

/* ---- step classification ------------------------------------------- */

test("classifyFailedStep reads the agent's own message prefixes", () => {
  assert.equal(classifyFailedStep('reach bucket "b": Access Denied'), "bucket");
  assert.equal(
    classifyFailedStep(
      'bucket "b" does not exist (or the credentials cannot see it)',
    ),
    "bucket",
  );
  assert.equal(
    classifyFailedStep('write probe to bucket "b": Access Denied'),
    "write",
  );
  assert.equal(
    classifyFailedStep(
      's3: cannot resolve endpoint host "nope.invalid": no such host',
    ),
    "client",
  );
  assert.equal(
    classifyFailedStep(
      's3: endpoint host "x" resolves to a disallowed private address 10.0.0.5; refusing to connect (SSRF guard)',
    ),
    "client",
  );
  assert.equal(classifyFailedStep("s3: empty endpoint"), "client");
});

test("classifyFailedStep blames NO step for a message it cannot place", () => {
  assert.equal(
    classifyFailedStep("something entirely new from minio-go"),
    null,
  );
  assert.equal(classifyFailedStep(""), null);
});

/* ---- a passing probe ----------------------------------------------- */

test("a passing probe marks every step passed and ends on success", () => {
  const r = report();
  assert.equal(r.ok, true);
  assert.equal(r.never, false);
  assert.equal(r.steps.length, 5);
  assert.ok(r.steps.every((s) => s.status === "passed"));
  assert.equal(r.lines.at(-1)?.level, "success");
  // The write probe names the reserved key it round-trips.
  assert.match(
    statusOf(r, "write") ? r.steps[3].detail : "",
    /\.deplo-s3check/,
  );
  // Nothing red anywhere.
  assert.equal(
    r.lines.some((l) => l.level === "error"),
    false,
  );
});

test("the passing report still says the cleanup delete is best effort", () => {
  // The agent ignores a RemoveObject failure, so the report must not imply it
  // verified the probe file was gone.
  const detail = report().steps.find((s) => s.key === "cleanup")!.detail;
  assert.match(detail, /best effort/i);
});

/* ---- failing probes ------------------------------------------------ */

test("a read-only key fails at the WRITE step, with the earlier steps passed", () => {
  const r = report({
    ok: false,
    error: 'write probe to bucket "deplo-backups": Access Denied.',
  });
  assert.equal(r.ok, false);
  assert.equal(statusOf(r, "agent"), "passed");
  assert.equal(statusOf(r, "client"), "passed");
  assert.equal(statusOf(r, "bucket"), "passed");
  assert.equal(statusOf(r, "write"), "failed");
  // Never claim the step after the failure ran.
  assert.equal(statusOf(r, "cleanup"), "skipped");
  // The agent's words appear VERBATIM in the log.
  assert.ok(
    r.lines.some(
      (l) => l.text === 'write probe to bucket "deplo-backups": Access Denied.',
    ),
  );
});

test("a missing bucket fails at the BUCKET step and skips the write", () => {
  const r = report({
    ok: false,
    error:
      'bucket "deplo-backups" does not exist (or the credentials cannot see it)',
  });
  assert.equal(statusOf(r, "bucket"), "failed");
  assert.equal(statusOf(r, "write"), "skipped");
  assert.equal(statusOf(r, "cleanup"), "skipped");
});

test("a bad endpoint fails before the bucket is ever touched", () => {
  const r = report({
    ok: false,
    error: 's3: cannot resolve endpoint host "nope.invalid": no such host',
  });
  assert.equal(statusOf(r, "client"), "failed");
  assert.equal(statusOf(r, "bucket"), "skipped");
});

test("no agent to run the probe is a verdict, blamed on the agent step", () => {
  const r = report({
    ok: false,
    error: "No provisioned server is available to verify the bucket.",
    serverName: "",
  });
  assert.equal(statusOf(r, "agent"), "failed");
  assert.equal(statusOf(r, "client"), "skipped");
  assert.match(r.steps[0].detail, /no server/i);
});

test("an unplaceable failure claims only the step we can vouch for", () => {
  const r = report({
    ok: false,
    error: "minio: unexpected EOF from the future",
  });
  // The agent answered, so that much is known; nothing else is asserted.
  assert.deepEqual(
    r.steps.map((s) => [s.key, s.status]),
    [["agent", "passed"]],
  );
  assert.ok(
    r.lines.some((l) => l.text === "minio: unexpected EOF from the future"),
  );
});

test("servers skipped on the way are logged as warnings", () => {
  const r = report({
    ok: true,
    agentAttempts: ["eu-main-1 - the agent is too old to back up"],
  });
  const warn = r.lines.find((l) => l.level === "warn");
  assert.match(warn?.text ?? "", /eu-main-1/);
  assert.match(warn?.text ?? "", /too old/);
});

/* ---- never tested -------------------------------------------------- */

test("a never-tested destination reports `never`, not a failure", () => {
  const r = emptyS3TestReport(target);
  assert.equal(r.never, true);
  assert.equal(r.error, "");
  assert.equal(r.steps.length, 0);
  // It still offers the reproduce commands (they need no verdict).
  assert.match(r.command, /head-bucket/);
  assert.equal(
    r.lines.some((l) => l.level === "error"),
    false,
  );
});

/* ---- the reproduce commands ---------------------------------------- */

test("reproduce commands cover the same three calls, in order", () => {
  const cmd = reproduceCommand(target);
  const head = cmd.indexOf("head-bucket");
  const put = cmd.indexOf("put-object");
  const del = cmd.indexOf("delete-object");
  assert.ok(head > 0 && put > head && del > put, cmd);
  // Single-quoted, all of it. This block is what an admin pastes into a shell
  // exactly when a destination is failing, and the bucket and region are strings
  // somebody else typed into a form.
  assert.ok(cmd.includes(`--bucket '${target.bucket}'`));
  assert.ok(cmd.includes(`--endpoint-url 'https://s3.example.com'`));
  assert.ok(cmd.includes(`--region 'eu-central-1'`));
  assert.ok(cmd.includes(PROBE_KEY));
});

test("a bucket name carrying shell syntax cannot escape the reproduce block", () => {
  // Deplo validates the name on the way in too, so this is the second of two
  // guards - and it is the one that survives someone loosening the first.
  const hostile = "b'; rm -rf /; echo '";
  const cmd = reproduceCommand({ ...target, bucket: hostile });
  // Every single quote inside the value is closed, escaped and reopened, so the
  // whole thing stays ONE shell word rather than three commands.
  const quoted = "'" + hostile.replaceAll("'", "'\\''") + "'";
  assert.ok(cmd.includes(`--bucket ${quoted}`), cmd);
  // And it never appears bare, which is the form that would actually run.
  assert.ok(!cmd.includes(`--bucket ${hostile}`), cmd);
});

test("reproduce commands NEVER carry a real credential", () => {
  const cmd = reproduceCommand(target);
  // Placeholders only - a stored secret has no reveal path in deplo, and this
  // block must not become one.
  assert.match(cmd, /AWS_ACCESS_KEY_ID='<access key>'/);
  assert.match(cmd, /AWS_SECRET_ACCESS_KEY='<secret key>'/);
});

test("a non-AWS provider is told to use path-style addressing; AWS is not", () => {
  assert.match(reproduceCommand(target), /addressing_style path/);
  assert.doesNotMatch(
    reproduceCommand({ ...target, provider: "aws" }),
    /addressing_style/,
  );
  // And the step detail names the style either way.
  assert.match(report().steps[1].detail, /path addressing/);
  assert.match(
    buildS3TestReport({
      target: { ...target, provider: "aws" },
      ok: true,
      error: "",
      startedAt: "",
      durationMs: 1,
      serverName: "s",
    }).steps[1].detail,
    /virtual-host addressing/,
  );
});

/* ---- a server destination is a FOLDER, not a bucket ----------------- */

/**
 * The report used to be S3-shaped for every destination, so testing a folder on a
 * server printed "Check the bucket exists", "PutObject /.deplo-s3check" and an
 * `aws s3api head-bucket --bucket ` with nothing after it.
 */
const serverReport = (
  over: Partial<Parameters<typeof buildS3TestReport>[0]> = {},
) =>
  buildS3TestReport({
    target: serverTarget,
    ok: true,
    error: "",
    startedAt: "2026-08-09T10:00:00.000Z",
    durationMs: 12,
    serverName: "eu-main-1",
    ...over,
  });

test("a server destination reports the folder sequence, never S3", () => {
  const r = serverReport();
  assert.deepEqual(
    r.steps.map((s) => s.key),
    ["agent", "root", "write", "cleanup"],
  );
  const text = [
    ...r.lines.map((l) => l.text),
    ...r.steps.map((s) => `${s.label} ${s.detail}`),
  ]
    .join("\n")
    .toLowerCase();
  for (const word of ["bucket", "endpoint", "s3", "putobject", "region"])
    assert.ok(
      !text.includes(word),
      `report should not mention "${word}": ${text}`,
    );
  assert.match(text, /\/var\/lib\/deplo\/backups/);
});

test("a folder probe blames the step the agent's own message names", () => {
  // deplo-agent internal/server/backup_store.go, verbatim prefixes.
  assert.equal(
    classifyFailedStep(
      'backup store path "/mnt/nope" does not exist on this server',
      "server",
    ),
    "root",
  );
  assert.equal(
    classifyFailedStep(
      'backup store path "/srv/keep" is not empty and holds no Deplo backups; point it at an empty directory',
      "server",
    ),
    "root",
  );
  assert.equal(
    classifyFailedStep(
      "cannot write to /mnt/ro: read-only file system",
      "server",
    ),
    "write",
  );
  // Unrecognised ⇒ blame nothing, exactly as on the S3 side.
  assert.equal(
    classifyFailedStep("something new from the agent", "server"),
    null,
  );
  // And an S3 message must not be read with the folder rules.
  assert.equal(
    classifyFailedStep('write probe to bucket "b": Access Denied'),
    "write",
  );
});

test("a read-only folder fails at the write step, with the root already passed", () => {
  const r = serverReport({
    ok: false,
    error: "cannot write to /var/lib/deplo/backups: read-only file system",
  });
  assert.equal(statusOf(r, "agent"), "passed");
  assert.equal(statusOf(r, "root"), "passed");
  assert.equal(statusOf(r, "write"), "failed");
  assert.equal(statusOf(r, "cleanup"), "skipped");
  assert.ok(
    r.lines.some((l) => l.level === "error" && l.text.includes("read-only")),
  );
});

test("an unreachable storage server blames reaching the server, not the folder", () => {
  const r = serverReport({
    ok: false,
    error: "agent unreachable",
    serverName: "",
  });
  assert.equal(statusOf(r, "agent"), "failed");
  assert.equal(statusOf(r, "root"), "skipped");
  assert.match(r.steps[0].detail, /did not run the check/);
});

test("the folder reproduce block is shell on that host, with no aws and no secret", () => {
  const cmd = reproduceCommand(serverTarget);
  assert.ok(!cmd.includes("aws "), cmd);
  assert.ok(!cmd.includes("AWS_"), cmd);
  assert.match(cmd, /FOLDER='\/var\/lib\/deplo\/backups'/);
  assert.match(cmd, /\.deplo-store-check/);
  assert.match(cmd, /df -h/);
});

test("an untested managed folder admits it does not know the path yet", () => {
  const bare = { ...serverTarget, path: "" };
  // No invented path anywhere: the agent picks it, and deplo learns it from the
  // first successful check.
  assert.ok(
    !reproduceCommand(bare).includes("/var/lib/deplo"),
    reproduceCommand(bare),
  );
  assert.match(reproduceCommand(bare), /FOLDER=\s/);
  const r = emptyS3TestReport(bare);
  assert.equal(r.never, true);
  assert.match(r.lines[0].text, /backup folder/);
  assert.ok(!r.command.includes("head-bucket"));
});
