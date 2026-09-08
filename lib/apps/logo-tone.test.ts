import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { logoToneFromDataUri } from "./logo-tone";

/** A 32x32 image of one colour, as the data-URI an app actually stores. */
async function dataUri(fill: number[]): Promise<string> {
  const raw = Buffer.alloc(32 * 32 * 4);
  for (let i = 0; i < raw.length; i += 4) raw.set(fill, i);
  const png = await sharp(raw, { raw: { width: 32, height: 32, channels: 4 } })
    .png()
    .toBuffer();
  return `data:image/png;base64,${png.toString("base64")}`;
}

test("a black-only mark asks for the dark theme's plate", async () => {
  assert.equal(
    await logoToneFromDataUri(await dataUri([0, 0, 0, 255])),
    "dark",
  );
});

test("a white-only mark asks for the light theme's plate", async () => {
  assert.equal(
    await logoToneFromDataUri(await dataUri([255, 255, 255, 255])),
    "light",
  );
});

test("a logo with colour needs no plate", async () => {
  assert.equal(
    await logoToneFromDataUri(await dataUri([59, 130, 246, 255])),
    null,
  );
});

test("nothing readable is nothing, never a throw", async () => {
  assert.equal(await logoToneFromDataUri(null), null);
  // The legacy shape: a template path from before the catalog moved out.
  assert.equal(await logoToneFromDataUri("/templates/uptime-kuma.webp"), null);
  assert.equal(await logoToneFromDataUri("data:image/png;base64,zzzz"), null);
});
