import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { dominantHue } from "./logo-color";

/**
 * The veil a template card wears is built from one number, and the two ways it
 * can go wrong are both invisible until someone looks at 388 cards: a hue that
 * isn't the logo's colour, and a hue for a logo that has no colour at all.
 *
 * Fixtures are painted here rather than committed: the check needs no network,
 * no catalogue and no binary in the repo. Lossless is load-bearing — lossy webp
 * smears the hues and makes the assertions flaky.
 */
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

/** Hues are circular: 359 and 1 are two degrees apart, not 358. */
function apart(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

test("a solid logo answers its own hue", async () => {
  const blue = await dominantHue(await logo([59, 130, 246, 255])); // #3b82f6
  assert.notEqual(blue, null);
  assert.ok(
    apart(blue!, 264) <= 12,
    `expected a blue hue near 264, got ${blue}`,
  );
});

test("a small saturated mark outvotes the field it sits on", async () => {
  // Why the histogram is weighted by chroma: 6% of the pixels carry the colour
  // and the black around them must contribute nothing at all.
  const orange = await dominantHue(
    await logo([0, 0, 0, 255], [249, 115, 22, 255]), // #f97316 on black
  );
  assert.notEqual(orange, null);
  assert.ok(
    apart(orange!, 51) <= 15,
    `expected an orange hue near 51, got ${orange}`,
  );
});

test("a colourless logo has no hue at all", async () => {
  // ~20% of the live catalogue is exactly this: black or white wordmarks. Each
  // one must answer null, not the numerically unstable hue of a grey.
  assert.equal(await dominantHue(await logo([0, 0, 0, 255])), null);
  assert.equal(await dominantHue(await logo([255, 255, 255, 255])), null);
  assert.equal(await dominantHue(await logo([120, 120, 120, 255])), null);
});

test("transparent pixels do not vote", async () => {
  // A fully transparent logo is not "red": with alpha ignored, the zeroed RGB
  // underneath would be read as a real colour.
  assert.equal(await dominantHue(await logo([0, 0, 0, 0])), null);
  // And a mark on transparent padding still reads as the mark's colour.
  const green = await dominantHue(await logo([0, 0, 0, 0], [34, 197, 94, 255]));
  assert.notEqual(green, null);
  assert.ok(
    apart(green!, 149) <= 15,
    `expected a green hue near 149, got ${green}`,
  );
});

test("bytes that are not an image degrade instead of throwing", async () => {
  // The catalogue is remote input; a page must not 500 because it served HTML.
  assert.equal(await dominantHue(Buffer.from("<!doctype html>")), null);
  assert.equal(await dominantHue(Buffer.alloc(0)), null);
});
