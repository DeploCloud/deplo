import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { FrameworkIcon } from "@/components/shared/framework-icons";
import type { DeplopackDetection } from "@/lib/apps/deplopack-types";
import { DeplopackDetections } from "./deplopack-fields";
import type { RepoAnalysisState } from "./use-repo-analysis";

function render(candidate: DeplopackDetection) {
  const state: RepoAnalysisState = {
    enabled: true,
    analysis: {
      receipt: "receipt",
      expiresAt: Date.now() + 60_000,
      commitSha: "sha",
      detectorVersion: "0.1.0",
      result: { success: true, detections: [candidate] },
    },
    selected: candidate,
    values: {},
    overrides: [],
    error: null,
    detecting: false,
    ready: true,
    select: () => {},
    change: () => {},
    reset: () => {},
    refresh: () => {},
  };
  return renderToStaticMarkup(createElement(DeplopackDetections, { state }));
}

test("Vite uses the original framework icon and displays Bun and SPA without the output directory", () => {
  const html = render({
    type: "node",
    metadata: {
      nodeRuntime: "vite",
      nodePackageManager: "bun",
      nodeIsSPA: "true",
      outputDirectory: "dist",
    },
  });
  const icon = renderToStaticMarkup(
    createElement(FrameworkIcon, { id: "vite", className: "size-4" }),
  );
  assert.ok(html.includes(icon));
  assert.match(html, />Vite<\/span>/);
  assert.match(html, /Bun · SPA/);
  assert.doesNotMatch(html, /dist|container port/);
  assert.match(html, /aria-checked="true"/);
});

test("SPA is displayed only when true and missing metadata falls back to Node.js", () => {
  for (const nodeIsSPA of ["false", ""]) {
    const html = render({
      type: "node",
      metadata: { nodeRuntime: "vite", nodePackageManager: "npm", nodeIsSPA },
    });
    assert.match(html, />npm<\/span>/);
    assert.doesNotMatch(html, /SPA/);
  }
  assert.match(render({ type: "node" }), />Node\.js<\/span>/);
});

test("Next.js reuses its catalog name and non-Node candidates keep their identifying path", () => {
  assert.match(
    render({
      type: "node",
      metadata: { nodeRuntime: "next", nodePackageManager: "yarnberry" },
    }),
    />Next\.js<\/span>/,
  );
  assert.match(
    render({
      type: "node",
      metadata: { nodeRuntime: "next", nodePackageManager: "yarnberry" },
    }),
    />Yarn<\/span>/,
  );
  assert.match(
    render({ type: "compose", path: "local/docker-compose.yml" }),
    /local\/docker-compose\.yml/,
  );
  assert.match(
    render({ type: "staticfile", rootDir: "public" }),
    />public<\/span>/,
  );
});
