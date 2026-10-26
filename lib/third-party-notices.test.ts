import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectNotices,
  githubUrl,
  renderNotices,
} from "../scripts/third-party-notices.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "notices-"));

function pkg(dir: string, json: object, files: Record<string, string> = {}) {
  const at = path.join(root, dir);
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, "package.json"), JSON.stringify(json));
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(at, name), body);
  }
}

describe("third-party notices", () => {
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

  const notices = collectNotices(root);
  const names = notices.map((n) => `${n.name}@${n.version}`);

  it("follows dependencies the way Node resolves them, and only those", () => {
    assert.deepEqual(names, ["a@1.0.0", "b@2.0.0"]);
  });

  it("keeps the license text, or the README's license section", () => {
    assert.equal(notices[0].text, "a's license");
    assert.equal(notices[1].text, "## License\n\nb's table");
    assert.equal(notices[1].github, "https://github.com/acme/b");
  });

  it("renders the download with every package and its source", () => {
    const out = renderNotices(notices);
    assert.match(out, /^a@1\.0\.0\nLicense: MIT\n\na's license$/m);
    assert.match(out, /Source: https:\/\/github\.com\/acme\/b\n\n## License/);
  });

  it("finds the GitHub page behind every way npm spells it", () => {
    for (const [repo, url] of [
      ["user/repo", "https://github.com/user/repo"],
      ["github:user/repo", "https://github.com/user/repo"],
      [
        "git+ssh://git@github.com/user/repo.git",
        "https://github.com/user/repo",
      ],
      ["https://github.com/user/repo#readme", "https://github.com/user/repo"],
      [
        { url: "git+https://github.com/org/mono.git", directory: "packages/x" },
        "https://github.com/org/mono/tree/HEAD/packages/x",
      ],
      ["git+https://gitlab.com/user/repo.git", null],
      ["gitlab:user/repo", null],
      [undefined, null],
    ] as const) {
      assert.equal(githubUrl(repo), url, JSON.stringify(repo));
    }
  });
});
