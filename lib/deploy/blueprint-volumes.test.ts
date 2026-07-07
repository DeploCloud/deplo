import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import yaml from "js-yaml";

import { volumeSource, isEscapingSource } from "./compose-lint";

/**
 * Guard the convention swap: every bundled blueprint must use the service-files
 * `./<x>` convention for its bind mounts — never the legacy `../files/<x>` /
 * `./files/<x>` form, and never a `..` escape (which the host-bind gate would
 * now block on deploy, breaking the one-click template for a non-privileged
 * user). This fails loudly if a newly-added template reintroduces the old shape.
 */

const BLUEPRINTS = join(process.cwd(), "templates", "blueprints");

type Doc = { services?: Record<string, { volumes?: unknown }> };

test("no blueprint compose uses the legacy files/ convention or a .. escape", () => {
  if (!existsSync(BLUEPRINTS)) return; // skip if run outside the repo root
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
      continue; // a template we can't parse can't assert sources; lint covers it
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
  assert.deepEqual(offenders, [], `blueprints must use the ./ convention:\n${offenders.join("\n")}`);
});
