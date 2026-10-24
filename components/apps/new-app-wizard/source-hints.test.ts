import { test } from "node:test";
import assert from "node:assert/strict";

import { nameFromRepo } from "./source-hints";

// The same rule createApp derives the slug (and so the container name) with.
const slug = (name: string) =>
  name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

test("a repo name reads as a title, and its slug does not move", () => {
  for (const [repo, name] of [
    ["acme/fenix-ui", "Fenix UI"],
    ["creator-wars", "Creator Wars"],
    ["acme/my_api-server", "My API Server"],
    ["media-NWEU-1", "Media NWEU 1"],
    ["BlinkMyPC", "BlinkMyPC"],
    ["next.js-starter", "Next.js Starter"],
    ["--s3-backup--", "S3 Backup"],
    ["group/sub/web-eur1", "Web Eur1"],
  ]) {
    assert.equal(nameFromRepo(repo), name, repo);
    assert.equal(slug(name), slug(repo.split("/").pop()!), repo);
  }
});
