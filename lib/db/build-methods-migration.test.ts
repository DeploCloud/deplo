import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import { seedApp, seedServer } from "../data/app-graph-test-helpers";
import { seedIdentity } from "../data/identity-test-helpers";
import { makeTestDb } from "./test-harness";

// The data half of 0184; its two ADD COLUMNs already ran when the harness replayed the journal.
const rewrite = readFileSync(
  path.join(process.cwd(), "lib/db/migrations/0184_build_methods_railpack.sql"),
  "utf8",
)
  .split("--> statement-breakpoint")
  .filter((s) => !/^\s*ALTER TABLE/m.test(s))
  .join(";\n");

test("0184 moves every retired builder onto Railpack and keeps what it served", async () => {
  const { db, pg } = await makeTestDb();
  try {
    await seedIdentity(db);
    await seedServer(db);
    // The shape 0185 drops, so the rewrite can read it.
    await pg.exec(
      `ALTER TABLE app_build_method_settings ADD COLUMN nixpacks_publish_directory text`,
    );
    const rows: [string, string, string | null, string | null][] = [
      ["app_nix", "nixpacks", null, null],
      ["app_nix_pub", "nixpacks", "dist", null],
      ["app_nix_out", "nixpacks", "dist", "build"],
      ["app_static", "static", null, "public"],
      ["app_heroku", "heroku", null, null],
      ["app_paketo", "paketo", null, null],
      ["app_rail", "railpack", null, null],
      ["app_docker", "dockerfile", null, null],
    ];
    for (const [id, method, publish, output] of rows) {
      await seedApp(db, { id, slug: id.replace("_", "-") });
      await pg.query(
        "update app_build set build_method = $1, output_directory = $2 where app_id = $3",
        [method, output, id],
      );
      await pg.query(
        "update app_build_method_settings set nixpacks_publish_directory = $1 where app_id = $2",
        [publish, id],
      );
    }
    await seedApp(db, { id: "app_git_stale", compose: "services: {}" });
    await seedApp(db, {
      id: "app_compose",
      source: "compose",
      repo: null,
      compose: "services:\n  web:\n    image: nginx\n",
    });

    await pg.exec(rewrite);

    const builds = Object.fromEntries(
      (
        await pg.query<{
          app_id: string;
          build_method: string;
          output_directory: string | null;
        }>("select app_id, build_method, output_directory from app_build")
      ).rows.map((r) => [r.app_id, [r.build_method, r.output_directory]]),
    );
    assert.deepEqual(builds.app_nix, ["railpack", null]);
    assert.deepEqual(builds.app_nix_pub, ["railpack", "dist"]);
    assert.deepEqual(
      builds.app_nix_out,
      ["railpack", "build"],
      "an output folder the app already had wins",
    );
    assert.deepEqual(builds.app_static, ["railpack", "public"]);
    assert.deepEqual(builds.app_heroku, ["railpack", null]);
    assert.deepEqual(builds.app_paketo, ["railpack", null]);
    assert.deepEqual(builds.app_rail, ["railpack", null]);
    assert.deepEqual(builds.app_docker, ["dockerfile", null]);

    const compose = Object.fromEntries(
      (
        await pg.query<{ id: string; compose: string | null }>(
          "select id, compose from apps where id in ('app_git_stale', 'app_compose')",
        )
      ).rows.map((r) => [r.id, r.compose]),
    );
    assert.equal(
      compose.app_git_stale,
      null,
      "a git app's unread compose column is cleared",
    );
    assert.ok(compose.app_compose, "a compose app keeps its stack");

    const auto = await pg.query<{ n: number }>(
      "select count(*)::int as n from app_build where build_method_auto",
    );
    assert.equal(auto.rows[0].n, 0, "existing apps keep the method they had");
  } finally {
    await pg.close();
  }
});
