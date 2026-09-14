import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { analyseLogo } from "./logo-color";

async function logo(fill: number[], mark?: number[]): Promise<Buffer> {
  const raw = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set(fill, i);
  if (mark)
    for (let y = 12; y < 20; y += 1)
      for (let x = 12; x < 20; x += 1) raw.set(mark, (y * 32 + x) * 4);
  return sharp(raw, { raw: { width: 32, height: 32, channels: 4 } })
    .webp({ lossless: true })
    .toBuffer();
}

// Hues are circular: 359 and 1 are two degrees apart, not 358.
function apart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

test("a solid logo answers its own hue", async () => {
  const { hue } = await analyseLogo(await logo([59, 130, 246, 255]));
  assert.notEqual(hue, undefined);
  assert.ok(apart(hue!, 264) <= 12, `expected a blue hue near 264, got ${hue}`);
});

test("a small saturated mark outvotes the field it sits on", async () => {
  // Weighted by chroma: 6% of the pixels carry the colour, the black must count for nothing.
  const { hue } = await analyseLogo(
    await logo([0, 0, 0, 255], [249, 115, 22, 255]),
  );
  assert.notEqual(hue, undefined);
  assert.ok(
    apart(hue!, 51) <= 15,
    `expected an orange hue near 51, got ${hue}`,
  );
});

test("transparent pixels do not vote", async () => {
  // With alpha ignored, the zeroed RGB under a transparent logo reads as a real colour.
  assert.deepEqual(await analyseLogo(await logo([0, 0, 0, 0])), {});
  const { hue } = await analyseLogo(
    await logo([0, 0, 0, 0], [34, 197, 94, 255]),
  );
  assert.notEqual(hue, undefined);
  assert.ok(
    apart(hue!, 149) <= 15,
    `expected a green hue near 149, got ${hue}`,
  );
});

test("a black wordmark asks for a plate on the dark theme", async () => {
  // The whole reason `tone` exists: this logo is invisible on a #0a0a0a card.
  const black = await analyseLogo(await logo([0, 0, 0, 255]));
  assert.equal(black.hue, undefined, "black is not a hue");
  assert.equal(black.tone, "dark");

  // Mostly transparent with black ink - the common shape in the catalogue.
  const ink = await analyseLogo(await logo([0, 0, 0, 0], [12, 12, 12, 255]));
  assert.equal(ink.tone, "dark");
});

test("a white wordmark asks for a plate on the light theme instead", async () => {
  const white = await analyseLogo(await logo([255, 255, 255, 255]));
  assert.equal(white.hue, undefined);
  assert.equal(white.tone, "light");
});

test("a coloured logo never asks for a plate", async () => {
  // A dark navy mark would be plated by any lightness-only rule; chroma carries it.
  const navy = await analyseLogo(await logo([0, 0, 0, 0], [24, 40, 120, 255]));
  assert.notEqual(navy.hue, undefined);
  assert.equal(navy.tone, undefined, "colour is visible on both surfaces");
});

test("bytes that are not an image degrade instead of throwing", async () => {
  // The catalogue is remote input; a page must not 500 because it served HTML.
  assert.deepEqual(await analyseLogo(Buffer.from("<!doctype html>")), {});
  assert.deepEqual(await analyseLogo(Buffer.alloc(0)), {});
});
