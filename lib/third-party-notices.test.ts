import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { thirdPartyNotices } from "../scripts/third-party-notices.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));

function pkg(dir: string, json: object, files: Record<string, string> = {}) {
  const at = path.join(root, dir);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, "package.json"), JSON.stringify(json));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(at, name), body);
  }
}

describe("thirdPartyNotices", () => {
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  pkg(".", {
    name: "app",
    dependencies: { a: "1" },
    optionalDependencies: { missing: "1" },
    devDependencies: { tool: "1" },
  });
  pkg(
    "node_modules/a",
    { name: "a", version: "1.0.0", license: "MIT", dependencies: { b: "2" } },
    { LICENSE: "a's license" },
  );
  pkg(
    "node_modules/a/node_modules/b",
    {
      name: "b",
      version: "2.0.0",
      license: "LGPL-3.0",
      repository: { url: "git+https://github.com/acme/b.git" },
    },
    { "README.md": "# b\n\n## License\n\nb's table\n\n## Usage\n\nnot this" },
  );
  pkg("node_modules/b", { name: "b", version: "1.0.0", license: "ISC" });
  pkg("node_modules/tool", { name: "tool", version: "1.0.0", license: "MIT" });

  const out = thirdPartyNotices(root);

  it("follows dependencies the way Node resolves them", () => {
    assert.match(out, /^a@1\.0\.0\nLicense: MIT\n\na's license$/m);
    assert.match(out, /^b@2\.0\.0\nLicense: LGPL-3\.0$/m);
    assert.doesNotMatch(out, /b@1\.0\.0/);
  });

  it("falls back to the README's license section", () => {
    assert.match(
      out,
      /Source: https:\/\/github\.com\/acme\/b\n\n## License\n\nb's table\n/,
    );
    assert.doesNotMatch(out, /not this/);
  });

  it("leaves out the app itself and what only builds it", () => {
    assert.doesNotMatch(out, /^(app|tool)@/m);
  });
});
