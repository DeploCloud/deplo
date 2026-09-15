import { test } from "node:test";
import assert from "node:assert/strict";
import { detectLogLevel, isLogContinuation } from "./log-level-detect";

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
    '{"level":60,"msg":"fatal"}': "error",
    '{"level":50,"msg":"err"}': "error",
    '{"level":40,"msg":"warn"}': "warn",
    '{"level":30,"msg":"info"}': "info",
    '{"level":20,"msg":"debug"}': "debug",
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
    "INFO:root:server started": "info",
    "E0824 10:00:00.123456       1 server.go:12] sync failed": "error",
    "W0824 10:00:00.123456       1 server.go:12] slow": "warn",
    "I0824 10:00:00.123456       1 server.go:12] ok": "info",
    "<11>Aug 24 10:00:00 host app: down": "error",
    "<14>Aug 24 10:00:00 host app: up": "info",
    "npm ERR! code E404": "error",
    "npm WARN deprecated left-pad@1.0.0": "warn",
    "npm notice created a lockfile": "info",
  });
});

test("structured levels: the level is not always the first bracket or word", () => {
  expect({
    "[main] INFO com.acme.App - started": "info",
    "2026-08-24 10:00:00.000 UTC [1] FATAL:  database is starting up": "error",
    "2026-08-24 10:00:00.000 UTC [1] LOG:  database system is ready": "info",
    "2026-08-24 10:00:00.000 UTC [1] WARNING:  no partition key": "warn",
    "2026-08-24 10:00:00.000  ERROR 1 --- [main] c.a.App : boom": "error",
    "2026-08-24 10:00:00.000  INFO 1 --- [main] c.a.App : up": "info",
  });
});

test("a declared level wins over anything the message says", () => {
  expect({
    '{"level":"info","msg":"panic: recovered in handler"}': "info",
    "[INFO] Traceback capture is enabled": "info",
    'level=debug msg="exit status 1 from probe"': "debug",
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
    "GET /api/users 200 3ms": "info",
    "GET /old 301 0ms": "info",
    '127.0.0.1 - - [24/Aug/2026:10:00:00] "GET / HTTP/1.1" 200 1234': "info",
    '127.0.0.1 - - [24/Aug/2026:10:00:00] "GET /x HTTP/1.1" 502 0': "error",
    '"statusCode": 503': "error",
    '"statusCode":"404"': "warn",
    "status=500 upstream timeout": "error",
    '{"DownstreamStatus":404,"RequestPath":"/x"}': "warn",
  });
});

test("the bare-number bug: a 3-digit token is never a status on its own", () => {
  expect({
    "built in 502 ms": "info",
    "Loaded 200 routes": "info",
    "Processed 500 items in batch": "info",
    "listening on port 404": "info",
    "code: 200": "info",
  });
});

test("the keyword bug: healthy-sounding words no longer paint a line", () => {
  expect({
    "Long running query detected on shard 3": "info",
    "container is running": "info",
    "Server listening on :8080": "info",
    "now serving at http://localhost:3000": "info",
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
    "ready in 340ms": "success",
  });
});

test("warn shapes that are not a tag", () => {
  expect({
    "config option `foo` is deprecated": "warn",
    "deprecation: use bar instead": "warn",
    "⚠ low memory": "warn",
  });
});

test("a producer counting the warnings it found", () => {
  expect({
    " 7 warnings found (use docker --debug to expand):": "warn",
    " 1 warning found (use docker --debug to expand):": "warn",
    "0 warnings found": "info",
    "no warnings found": "info",
  });
});

test("info is the default, and the default is most lines", () => {
  expect({
    "Starting application": "info",
    "GET /healthz": "info",
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
  const adversarial = `    at ${"a".repeat(5_000)}`;
  const started = process.hrtime.bigint();
  detectLogLevel(adversarial);
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 50, `took ${ms}ms`);
});
