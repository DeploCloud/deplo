import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPhases } from "./build-phases";
import type { LogLine } from "./types/deployment";

const STARTED = "2026-08-27T19:39:14.522Z";
const DURATION = 78_964;

function cmd(ts: string, text: string): LogLine {
  return { ts, level: "command", text };
}
function info(ts: string, text: string): LogLine {
  return { ts, level: "info", text };
}

const RAILPACK_BUILD: LogLine[] = [
  cmd(
    "2026-08-27T19:39:15.218Z",
    "git clone https://github.com/o/r (dev) [on agent]",
  ),
  cmd("2026-08-27T19:39:15.337Z", "git clone https://github.com/o/r.git (dev)"),
  info("2026-08-27T19:39:21.393Z", "Checked out fceeb0972931"),
  cmd(
    "2026-08-27T19:39:21.613Z",
    "railpack prepare /tmp/deplo-git-web-1 --env X",
  ),
  cmd(
    "2026-08-27T19:39:21.911Z",
    "docker build --build-arg BUILDKIT_SYNTAX=x -f /tmp/p",
  ),
  cmd(
    "2026-08-27T19:40:31.498Z",
    "docker build (relabel deplo/web:dpl_cce7fdbd)",
  ),
  cmd("2026-08-27T19:40:32.527Z", "docker compose up -d"),
  info(
    "2026-08-27T19:40:34.236Z",
    "Reclaimed 476 MB from superseded app images",
  ),
];

test("a railpack build splits into five phases that sum to the measured duration", () => {
  const phases = buildPhases({
    logs: RAILPACK_BUILD,
    startedAt: STARTED,
    buildDurationMs: DURATION,
    nowMs: 0,
  });
  assert.deepEqual(
    phases.map((p) => p.key),
    ["initialize", "clone", "prepare", "build", "deploy"],
  );
  assert.deepEqual(
    phases.map((p) => p.ms),
    [696, 6395, 298, 70_616, 959],
  );
  assert.equal(
    phases.reduce((n, p) => n + p.ms, 0),
    DURATION,
  );
});

test("the two clone lines and build+relabel each collapse into one phase", () => {
  const phases = buildPhases({
    logs: RAILPACK_BUILD,
    startedAt: STARTED,
    buildDurationMs: DURATION,
    nowMs: 0,
  });
  assert.equal(phases.filter((p) => p.key === "clone").length, 1);
  assert.equal(phases.filter((p) => p.key === "build").length, 1);
});

test("a compose stack has one command, so two phases", () => {
  const phases = buildPhases({
    logs: [
      cmd("2026-08-26T16:07:58.412Z", "docker compose up -d --remove-orphans"),
      info(
        "2026-08-26T16:08:06.898Z",
        "Waiting for the stack to become healthy",
      ),
    ],
    startedAt: "2026-08-26T16:07:57.802Z",
    buildDurationMs: 9261,
    nowMs: 0,
  });
  assert.deepEqual(
    phases.map((p) => [p.key, p.ms]),
    [
      ["initialize", 610],
      ["deploy", 8651],
    ],
  );
});

test("an upload extracts and a prebuilt image pulls", () => {
  const keys = (text: string) =>
    buildPhases({
      logs: [cmd("2026-08-27T19:39:20.000Z", text)],
      startedAt: STARTED,
      buildDurationMs: DURATION,
      nowMs: 0,
    }).map((p) => p.key);
  assert.deepEqual(keys("extract app.tar.gz"), ["initialize", "extract"]);
  assert.deepEqual(keys("docker pull nginx:latest"), ["initialize", "pull"]);
});

test("a live build runs its last phase up to now", () => {
  const phases = buildPhases({
    logs: RAILPACK_BUILD.slice(0, 5),
    startedAt: STARTED,
    buildDurationMs: null,
    nowMs: Date.parse("2026-08-27T19:39:51.911Z"),
  });
  assert.equal(phases[phases.length - 1].key, "build");
  assert.equal(phases[phases.length - 1].ms, 30_000);
});

test("nothing to draw while queued, or with no recognized command", () => {
  const base = { startedAt: STARTED, buildDurationMs: DURATION, nowMs: 0 };
  assert.deepEqual(
    buildPhases({ ...base, logs: RAILPACK_BUILD, startedAt: null }),
    [],
  );
  assert.deepEqual(buildPhases({ ...base, logs: [] }), []);
  assert.deepEqual(
    buildPhases({
      ...base,
      logs: [info("2026-08-27T19:39:20.000Z", "docker compose up -d")],
    }),
    [],
    "a compose line at info level is output, not a boundary",
  );
  assert.deepEqual(
    buildPhases({
      ...base,
      logs: [cmd("2026-08-27T19:39:20.000Z", "buildctl build --frontend x")],
    }),
    [],
    "an unrecognized command opens no phase",
  );
});

test("a boundary replayed out of order is clamped, keeping the total exact", () => {
  const phases = buildPhases({
    logs: [
      cmd("2026-08-27T19:39:16.000Z", "git clone https://github.com/o/r (dev)"),
      cmd("2026-08-27T19:39:10.000Z", "docker build -f Dockerfile ."),
      cmd("2026-08-27T20:00:00.000Z", "docker compose up -d"),
    ],
    startedAt: STARTED,
    buildDurationMs: DURATION,
    nowMs: 0,
  });
  assert.ok(phases.every((p) => p.ms >= 0));
  assert.equal(
    phases.reduce((n, p) => n + p.ms, 0),
    DURATION,
  );
});

for (const historical of [false, true]) {
  test(`DeploPack ${historical ? "historical" : "command markers"} separates fetch, preparation, build and deploy`, () => {
    const at = (seconds: number) =>
      new Date(Date.parse(STARTED) + seconds * 1000).toISOString();
    const logs = [
      cmd(at(1), "git fetch https://github.com/o/r (sha) [on agent]"),
      cmd(at(1), "git fetch https://github.com/o/r (sha)"),
      historical
        ? info(at(3), "Building with DeploPack 0.1.0 (rust)")
        : cmd(at(3), "deplopack prepare"),
      info(at(4), "  $ cargo build --release"),
      ...(historical ? [] : [cmd(at(5), "deplopack build")]),
      info(at(5), "  Starting Docker Build..."),
      info(at(6), "#3 resolve image"),
      cmd(at(8), "docker build (relabel image)"),
      cmd(at(9), "docker compose up -d"),
    ];
    const phases = buildPhases({
      logs,
      startedAt: STARTED,
      buildDurationMs: 11000,
      nowMs: 0,
    });
    assert.deepEqual(
      phases.map((p) => [p.key, p.ms]),
      [
        ["initialize", 1000],
        ["clone", 2000],
        ["prepare", 2000],
        ["build", 4000],
        ["deploy", 2000],
      ],
    );
    for (const duration of [7000, 8000]) {
      const stopped = buildPhases({
        logs: logs.slice(0, historical ? 6 : 7),
        startedAt: STARTED,
        buildDurationMs: duration,
        nowMs: 0,
      });
      assert.equal(stopped.at(-1)?.key, "build");
      assert.equal(
        stopped.reduce((sum, p) => sum + p.ms, 0),
        duration,
      );
    }
    const live = buildPhases({
      logs: logs.slice(0, historical ? 6 : 7),
      startedAt: STARTED,
      buildDurationMs: null,
      nowMs: Date.parse(at(7)),
    });
    assert.equal(live.at(-1)?.ms, 2000);
  });
}
