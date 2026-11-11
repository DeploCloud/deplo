import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { AppPreviewDTO } from "@/lib/data/previews";
import { PreviewStatus } from "./previews-table";

const preview = (status: AppPreviewDTO["status"]): AppPreviewDTO => ({
  id: "prv_1",
  appId: "prj_1",
  prNumber: 7,
  title: "Add dark mode",
  author: "octocat",
  pullRequestUrl: "https://github.com/acme/web/pull/7",
  headBranch: "feat/dark-mode",
  baseBranch: "main",
  headRepo: "acme/web",
  isFork: false,
  approved: true,
  approvedSha: null,
  status,
  url: "http://web-pr-7.example.test",
  host: "web-pr-7.example.test",
  closed: false,
  latestDeploymentId: "dpl_1",
  createdAt: "2026-11-08T00:00:00.000Z",
  updatedAt: "2026-11-08T00:00:00.000Z",
});

const text = (status: AppPreviewDTO["status"]) =>
  renderToStaticMarkup(
    createElement(PreviewStatus, { preview: preview(status), maxActive: 3 }),
  ).replace(/<[^>]+>/g, "");

test("a preview whose server stopped reads Offline: its server stopped, never Running", () => {
  assert.equal(text("offline"), "Offline: its server stopped");
  assert.equal(text("active"), "Running");
});
