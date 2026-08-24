import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLogLevel, isLogContinuation } from "./log-level-detect";

/** Assert a whole table at once and report the offending line, not just a bool. */
function expect(cases: Record<string, string>) {
  for (const [line, want] of Object.entries(cases)) {
    assert.equal(detectLogLevel(line), want, JSON.stringify(line));
  }
}

test("structured levels: JSON, the shape the old detector missed entirely", () => {
  expect({
    '{"level":"error","msg":"connect failed"}': "error",
    '{"msg":"x","level":"warn"}': "warn",
    '{"severity":"WARNING","message":"disk"}': "warn",
    '{"log.level":"debug","event":"span"}': "debug",
    '{"levelname":"INFO","name":"app"}': "info",
    // pino/bunyan numeric scale
    '{"level":60,"msg":"fatal"}': "error",
    '{"level":50,"msg":"err"}': "error",
    '{"level":40,"msg":"warn"}': "warn",
    '{"level":30,"msg":"info"}': "info",
    '{"level":20,"msg":"debug"}': "debug",
    // a notice is BELOW a warning in syslog, so it reads as info
    '{"level":"notice","msg":"index created"}': "info",
  });
});

test("structured levels: logfmt, brackets, tags, glog, syslog, npm", () => {
  expect({
    'level=error msg="boom"': "error",
    "severity=warn component=pool": "warn",
    "level=debug step=3": "debug",
    "[ERROR] connection refused": "error",
    "[warning] retrying": "warn",
    "[trace] span started": "debug",
    "ERROR: failed to bind port": "error",
    "err: socket closed": "error",
    "warn: cache miss": "warn",
    "debug: payload size 42": "debug",
    "INFO:root:server started": "info", // python logging's default format
    "E0824 10:00:00.123456       1 server.go:12] sync failed": "error",
    "W0824 10:00:00.123456       1 server.go:12] slow": "warn",
    "I0824 10:00:00.123456       1 server.go:12] ok": "info",
    "<11>Aug 24 10:00:00 host app: down": "error", // 11 % 8 == 3 == err
    "<14>Aug 24 10:00:00 host app: up": "info", // 14 % 8 == 6 == info
    "npm ERR! code E404": "error",
    "npm WARN deprecated left-pad@1.0.0": "warn",
    "npm notice created a lockfile": "info",
  });
});

test("structured levels: the level is not always the first bracket or word", () => {
  expect({
    // logback / Postgres put a thread name or a pid in front of the level
    "[main] INFO com.acme.App - started": "info",
    "2026-08-24 10:00:00.000 UTC [1] FATAL:  database is starting up": "error",
    "2026-08-24 10:00:00.000 UTC [1] LOG:  database system is ready": "info",
    "2026-08-24 10:00:00.000 UTC [1] WARNING:  no partition key": "warn",
    // a bare uppercase level column (Spring Boot, log4j, Serilog)
    "2026-08-24 10:00:00.000  ERROR 1 --- [main] c.a.App : boom": "error",
    "2026-08-24 10:00:00.000  INFO 1 --- [main] c.a.App : up": "info",
  });
});

test("a declared level wins over anything the message says", () => {
  // The producer knows something we don't: a line logged at info that happens
  // to quote a panic is still an info line.
  expect({
    '{"level":"info","msg":"panic: recovered in handler"}': "info",
    "[INFO] Traceback capture is enabled": "info",
    "level=debug msg=\"exit status 1 from probe\"": "debug",
  });
});

test("known error shapes: frames, tracebacks, exits, errno", () => {
  expect({
    "    at Object.<anonymous> (/app/index.js:10:5)": "error",
    "at Socket.emit (net.js:334:8)": "error",
    '  File "/app/main.py", line 42, in handler': "error",
    "Caused by: java.net.SocketException": "error",
    "\t... 24 more": "error",
    "goroutine 1 [running]:": "error",
    "Traceback (most recent call last):": "error",
    "TypeError: cannot read property 'x' of undefined": "error",
    "Uncaught TypeError: x is not a function": "error",
    "java.io.IOException: broken pipe": "error",
    "unhandled promise rejection": "error",
    "Segmentation fault (core dumped)": "error",
    "container was OOMKilled": "error",
    "process exited with code 137": "error",
    "exit status 1": "error",
    "errno=2": "error",
    "code: ECONNREFUSED": "error",
    "Error: connect ECONNREFUSED 127.0.0.1:5432": "error",
  });
});

test("a status code is read only inside a recognised access log", () => {
  expect({
    "GET /api/users 500 12ms": "error",
    "POST /login 401": "warn",
    "GET /api/users 200 3ms": "info", // 2xx stays neutral, it is not news
    "GET /old 301 0ms": "info",
    '127.0.0.1 - - [24/Aug/2026:10:00:00] "GET / HTTP/1.1" 200 1234': "info",
    '127.0.0.1 - - [24/Aug/2026:10:00:00] "GET /x HTTP/1.1" 502 0': "error",
    // a NAMED status field is structured evidence and needs no method
    '"statusCode": 503': "error",
    '"statusCode":"404"': "warn",
    "status=500 upstream timeout": "error",
    '{"DownstreamStatus":404,"RequestPath":"/x"}': "warn",
  });
});

test("the bare-number bug: a 3-digit token is never a status on its own", () => {
  // Every one of these was mis-coloured before: `levelFromStatusCode` matched
  // any 3-digit token bounded by spaces, so a duration or a count took the
  // colour of the HTTP range it happened to land in.
  expect({
    "built in 502 ms": "info", // was ERROR
    "Loaded 200 routes": "info", // was SUCCESS
    "Processed 500 items in batch": "info", // was ERROR
    "listening on port 404": "info", // was WARN
    "code: 200": "info", // was ERROR (`code\s*[:=]\s*\d+` meant errno)
  });
});

test("the keyword bug: healthy-sounding words no longer paint a line", () => {
  expect({
    "Long running query detected on shard 3": "info", // was SUCCESS
    "container is running": "info", // was SUCCESS
    "Server listening on :8080": "info", // was SUCCESS
    "now serving at http://localhost:3000": "info", // was SUCCESS
    "no failures detected, all good": "info",
    "error handling middleware registered": "info",
    "the request may cause a retry": "info",
  });
});

test("success is claimed, never inferred", () => {
  expect({
    "[OK] migration applied": "success",
    "[success] uploaded": "success",
    "✓ build done": "success",
    "compiled successfully": "success",
    "ready in 340ms": "success", // Next.js / Vite print this as their green line
  });
});

test("warn shapes that are not a tag", () => {
  expect({
    "config option `foo` is deprecated": "warn",
    "deprecation: use bar instead": "warn",
    "⚠ low memory": "warn",
  });
});

test("info is the default, and the default is most lines", () => {
  expect({
    "Starting application": "info",
    "GET /healthz": "info", // a method with no status is not an access log
    "user logged in": "info",
    "": "info",
    "{}": "info",
    "-----------------------": "info",
  });
});

test("isLogContinuation: a trace is one event, not a dozen records", () => {
  for (const line of [
    "    at Object.foo (/app/x.js:1:1)",
    "at Socket.emit (net.js:334:8)",
    '  File "/app/main.py", line 42',
    "Caused by: java.lang.NullPointerException",
    "\t... 24 more",
    "goroutine 1 [running]:",
    "  indented detail line",
    "}",
    "]",
  ]) {
    assert.equal(isLogContinuation(line), true, JSON.stringify(line));
  }

  for (const line of [
    "Starting application",
    "[ERROR] boom",
    "GET /api/users 200 3ms",
    "",
  ]) {
    assert.equal(isLogContinuation(line), false, JSON.stringify(line));
  }
});

test("classification is bounded work per line (no catastrophic backtracking)", () => {
  // A frame-shaped line with no `:<digit>` used to backtrack O(n^2) here, and
  // this runs per raw container log line, client-side.
  const adversarial = `    at ${"a".repeat(5_000)}`;
  const started = process.hrtime.bigint();
  detectLogLevel(adversarial);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `took ${ms}ms`);
});
