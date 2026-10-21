import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateRawSync } from "node:zlib";

import { __setExtractLimitsForTest, extractArchive } from "./upload";

// One deflated entry per file; `declared` lies about the inflated size like a crafted upload can.
function makeZip(files: { name: string; data: Buffer; declared?: number }[]) {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = deflateRawSync(f.data);
    const size = f.declared ?? f.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc32(f.data), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(crc32(f.data), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

describe("extractArchive", () => {
  let dir: string;
  let restore: ReturnType<typeof __setExtractLimitsForTest>;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "deplo-upload-test-"));
    restore = __setExtractLimitsForTest({ bytes: 64 * 1024, entries: 3 });
  });
  after(async () => {
    __setExtractLimitsForTest(restore);
    await rm(dir, { recursive: true, force: true });
  });

  const archiveAt = async (name: string, bytes: Buffer) => {
    const path = join(dir, name);
    await writeFile(path, bytes);
    return {
      id: "upl_t",
      filename: name,
      path,
      size: bytes.length,
      uploadedAt: "",
    };
  };
  const extract = async (archive: Awaited<ReturnType<typeof archiveAt>>) => {
    const lines: string[] = [];
    const out = await mkdtemp(join(dir, "out-"));
    const run = extractArchive(archive, out, (l) => lines.push(l));
    return { run, lines };
  };

  test("a zip that lies about its size is refused before unzip writes", async () => {
    const zip = await archiveAt(
      "lie.zip",
      makeZip([
        { name: "a.bin", data: Buffer.alloc(1024 * 1024), declared: 10 },
      ]),
    );
    const { run, lines } = await extract(zip);
    await assert.rejects(run, /extraction limit/);
    assert.ok(
      !lines.some((l) => l.startsWith("unzip ")),
      "the size has to be counted before anything lands on disk",
    );
  });

  test("a zip with too many files is refused", async () => {
    const files = ["a", "b", "c", "d"].map((name) => ({
      name,
      data: Buffer.from(name),
    }));
    const { run } = await extract(await archiveAt("many.zip", makeZip(files)));
    await assert.rejects(run, /more than 500,000 files/);
  });

  test("a tar with too many files is refused", async () => {
    const src = join(dir, "many");
    await mkdir(src);
    for (const n of ["a", "b", "c", "d"]) await writeFile(join(src, n), n);
    execFileSync("tar", ["-cf", join(dir, "many.tar"), "-C", src, "."]);
    const tar = await readFile(join(dir, "many.tar"));
    const { run } = await extract(await archiveAt("many.tar", tar));
    await assert.rejects(run, /more than 500,000 files/);
  });

  test("ordinary archives still extract", async () => {
    const zip = await archiveAt(
      "ok.zip",
      makeZip([
        { name: "site/index.html", data: Buffer.from("<h1>hi</h1>") },
        { name: "site/app.js", data: Buffer.from("console.log(1)") },
      ]),
    );
    const root = await (await extract(zip)).run;
    assert.equal(
      await readFile(join(root, "index.html"), "utf8"),
      "<h1>hi</h1>",
    );

    const src = join(dir, "ok");
    await mkdir(join(src, "site"), { recursive: true });
    await writeFile(join(src, "site", "index.html"), "<h1>tar</h1>");
    execFileSync("tar", ["-cf", join(dir, "ok.tar"), "-C", src, "site"]);
    const tar = await archiveAt("ok.tar", await readFile(join(dir, "ok.tar")));
    const tarRoot = await (await extract(tar)).run;
    assert.equal(
      await readFile(join(tarRoot, "index.html"), "utf8"),
      "<h1>tar</h1>",
    );
  });

  test("a tar that stops reading at its end marker still extracts", async () => {
    const prev = __setExtractLimitsForTest({ bytes: 4 * 1024 * 1024 });
    try {
      const src = join(dir, "early");
      await mkdir(join(src, "site"), { recursive: true });
      await writeFile(join(src, "site", "index.html"), "<h1>early</h1>");
      execFileSync("tar", ["-cf", join(dir, "early.tar"), "-C", src, "site"]);
      // Trailing bytes tar never reads: it exits before the write side finishes.
      const bytes = Buffer.concat([
        await readFile(join(dir, "early.tar")),
        Buffer.alloc(2 * 1024 * 1024),
      ]);
      const root = await (
        await extract(await archiveAt("early.tar", bytes))
      ).run;
      assert.equal(
        await readFile(join(root, "index.html"), "utf8"),
        "<h1>early</h1>",
      );
    } finally {
      __setExtractLimitsForTest(prev);
    }
  });
});
