import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  containerRows,
  containersSummary,
  productionHint,
  type RuntimeContainerLike,
  type RuntimeLike,
} from "./production-summary";

const repo = {
  provider: "github" as const,
  url: "https://github.com/acme/web",
  repo: "acme/web",
  branch: "main",
};
const app = (over: Partial<Parameters<typeof productionHint>[0]> = {}) => ({
  source: "github" as const,
  repo,
  compose: null,
  dockerImage: null,
  autoDeploy: true,
  ...over,
});
const text = (h: ReturnType<typeof productionHint>) =>
  h?.parts.map((p) => (typeof p === "string" ? p : `\`${p.code}\``)).join("");

const ctr = (
  over: Partial<RuntimeContainerLike> = {},
): RuntimeContainerLike => ({
  name: "web-1",
  service: "web",
  state: "running",
  health: "",
  restartCount: 0,
  running: true,
  exposed: false,
  ...over,
});
const runtime = (
  containers: RuntimeContainerLike[],
  missing: string[] = [],
): RuntimeLike => ({
  total: containers.length,
  running: containers.filter((c) => c.running).length,
  missing,
  unreachable: false,
  containers,
});

describe("production-summary", () => {
  test("a push app names its branch only while auto-deploy is on", () => {
    assert.equal(
      text(productionHint(app())),
      "Every push to `main` deploys to production.",
    );
    assert.equal(
      text(productionHint(app({ autoDeploy: false }))),
      "Auto-deploy is off. Pushes to `main` wait for a redeploy.",
    );
  });

  test("a tag trigger and watched paths are not described as every push", () => {
    assert.equal(
      text(productionHint(app({ repo: { ...repo, triggerType: "tag" } }))),
      "Every new tag deploys to production.",
    );
    assert.match(
      text(productionHint(app({ repo: { ...repo, watchPaths: ["api/**"] } })))!,
      /watched paths/,
    );
  });

  test("sources without a repo get their own update path", () => {
    assert.match(
      text(
        productionHint(
          app({ source: "compose", repo: null, compose: "services: {}" }),
        ),
      )!,
      /^Compose changes/,
    );
    assert.equal(
      text(
        productionHint(
          app({ source: "docker-image", repo: null, dockerImage: "nginx:1" }),
        ),
      ),
      "Redeploy to pull the latest `nginx:1`.",
    );
    assert.match(
      text(productionHint(app({ source: "upload", repo: null })))!,
      /archive/,
    );
  });

  test("rows put what needs a look first, and list a service with no container", () => {
    const rows = containerRows(
      runtime(
        [
          ctr({ name: "a-1", service: "api" }),
          ctr({
            name: "c-1",
            service: "cache",
            state: "restarting",
            running: false,
            restartCount: 4,
          }),
          ctr({ name: "b-1", service: "db", health: "unhealthy" }),
        ],
        ["worker"],
      ),
    );
    assert.deepEqual(
      rows.map((r) => [r.label, r.state]),
      [
        ["cache", "Restarting"],
        ["db", "Unhealthy"],
        ["worker", "Not created"],
        ["api", "Running"],
      ],
    );
    assert.equal(rows[2].container, null);
  });

  test("the summary counts every container, however many there are", () => {
    const twelve = Array.from({ length: 12 }, (_, n) =>
      ctr({ name: `s${n}`, service: `s${n}` }),
    );
    assert.equal(containersSummary(runtime(twelve)).text, "12 running");
    twelve[3] = ctr({
      name: "s3",
      service: "s3",
      state: "restarting",
      running: false,
    });
    assert.deepEqual(containersSummary(runtime(twelve)), {
      dot: "unhealthy",
      text: "11 of 12 running",
    });
    assert.equal(
      containersSummary(runtime([ctr()], ["worker"])).text,
      "1 of 2 running",
    );
    assert.equal(
      containersSummary({ ...runtime([ctr()]), unreachable: true }).text,
      "Unreachable",
    );
  });
});
