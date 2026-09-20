import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import * as yaml from "js-yaml";

import { volumeSource, isEscapingSource } from "./compose-lint/volumes";

const BLUEPRINTS = join(process.cwd(), "templates", "blueprints");

type Doc = { services?: Record<string, { volumes?: unknown }> };

test("no blueprint compose uses the legacy files/ convention or a .. escape", () => {
  if (!existsSync(BLUEPRINTS)) return;
  const offenders: string[] = [];
  for (const dir of readdirSync(BLUEPRINTS)) {
    const file = join(BLUEPRINTS, dir, "docker-compose.yml");
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (/(?:\.\.?\/)+files\//.test(text)) {
      offenders.push(`${dir}: legacy files/ convention`);
    }
    let doc: Doc | null = null;
    try {
      doc = yaml.load(text) as Doc;
    } catch {
      continue;
    }
    for (const [svc, s] of Object.entries(doc?.services ?? {})) {
      const vols = s?.volumes;
      if (!Array.isArray(vols)) continue;
      for (const v of vols) {
        const src = volumeSource(v);
        if (isEscapingSource(src)) {
          offenders.push(`${dir}/${svc}: '..' escape source "${src}"`);
        }
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `blueprints must use the ./ convention:\n${offenders.join("\n")}`,
  );
});
