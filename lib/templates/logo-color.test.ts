import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { analyseLogo } from "./logo-color";

/**
 * A card is drawn from what this function says about a logo, and every way it
 * can be wrong is invisible until someone looks at 388 cards at once: a hue
 * that isn't the logo's colour, a hue for a logo that has none, and — the one
 * that actually makes a card unreadable — failing to notice that a logo drawn
 * only in black will vanish into the dark theme's card.
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
  const { hue } = await analyseLogo(await logo([59, 130, 246, 255])); // #3b82f6
  assert.notEqual(hue, undefined);
  assert.ok(apart(hue!, 264) <= 12, `expected a blue hue near 264, got ${hue}`);
});

test("a small saturated mark outvotes the field it sits on", async () => {
  // Why the histogram is weighted by chroma: 6% of the pixels carry the colour
  // and the black around them must contribute nothing at all.
  const { hue } = await analyseLogo(
    await logo([0, 0, 0, 255], [249, 115, 22, 255]), // #f97316 on black
  );
  assert.notEqual(hue, undefined);
  assert.ok(
    apart(hue!, 51) <= 15,
    `expected an orange hue near 51, got ${hue}`,
  );
});

test("transparent pixels do not vote", async () => {
  // A fully transparent logo is not "red": with alpha ignored, the zeroed RGB
  // underneath would be read as a real colour.
  assert.deepEqual(await analyseLogo(await logo([0, 0, 0, 0])), {});
  // And a mark on transparent padding still reads as the mark's colour.
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

  // Mostly transparent with black ink — the common shape in the catalogue.
  const ink = await analyseLogo(await logo([0, 0, 0, 0], [12, 12, 12, 255]));
  assert.equal(ink.tone, "dark");
});

test("a white wordmark asks for a plate on the light theme instead", async () => {
  const white = await analyseLogo(await logo([255, 255, 255, 255]));
  assert.equal(white.hue, undefined);
  assert.equal(white.tone, "light");
});

test("a coloured logo never asks for a plate", async () => {
  // A dark navy mark sits near the dark card's lightness and would be plated by
  // any lightness-only rule — but chroma carries it, so it must not be.
  const navy = await analyseLogo(await logo([0, 0, 0, 0], [24, 40, 120, 255]));
  assert.notEqual(navy.hue, undefined);
  assert.equal(navy.tone, undefined, "colour is visible on both surfaces");
});

test("bytes that are not an image degrade instead of throwing", async () => {
  // The catalogue is remote input; a page must not 500 because it served HTML.
  assert.deepEqual(await analyseLogo(Buffer.from("<!doctype html>")), {});
  assert.deepEqual(await analyseLogo(Buffer.alloc(0)), {});
});
