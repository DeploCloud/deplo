import "server-only";

import { templateImageBytes } from "@/templates/catalog";
import type { CatalogTemplate } from "@/templates/types";

/**
 * The one accent a template gets: the dominant HUE of its logo, in degrees.
 *
 * The store paints a monochrome veil behind every card and behind the logo on a
 * template's page. Only a hue crosses to the browser — lightness and chroma are
 * fixed in CSS — so a veil can never come out as two tints, and a garish logo
 * cannot produce a garish card.
 *
 * A logo with no usable hue answers `null` rather than a hue nobody would call
 * that logo's colour: a black wordmark on transparent is not "red", and the
 * card falls back to a neutral veil built from the theme's own tokens.
 */

/** Below this OKLCH chroma a pixel is grey, white or black — it has no colour. */
const MIN_CHROMA = 0.04;
/** 15° buckets. Finer splits a single brand colour across two neighbours. */
const BUCKETS = 24;
/** A hue nobody would name: too few coloured pixels to be the logo's colour. */
const MIN_SHARE = 0.15;
const MIN_COLOURED_PIXELS = 4;

/** Concurrent logo fetches. The catalog answers `ratelimit-limit: 600`/min and
 *  a cold cache needs one request per template; 386 sockets opened at once on
 *  one origin leaves nothing for anyone else sharing that bucket. Measured: a
 *  whole cold catalogue resolves in well under a second at this width. */
const CONCURRENCY = 16;
/** A cold whole-catalogue pass has this long before the page renders untinted.
 *  Measured cost is ~0.5s, so this only ever fires on a catalogue having a very
 *  bad day — and ADR-0023 says the catalogue degrades, it does not error. */
const BUDGET_MS = 8000;

/** Resolved once. A native module that will not load must not be able to take
 *  the Templates section down, so a failure here is a catalogue with no tints. */
type Sharp = (typeof import("sharp"))["default"];
let sharpModule: Promise<Sharp | null> | undefined;
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp")
    .then((m) => m.default)
    .catch(() => null);
  return sharpModule;
}

/** sRGB 0-255 → OKLab. The transform the `oklch()` in globals.css inverts, so
 *  the veil reads as the same hue the eye picks out of the logo. */
function oklab(r8: number, g8: number, b8: number) {
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const r = lin(r8);
  const g = lin(g8);
  const b = lin(b8);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * The dominant hue of an encoded image, or `null`.
 *
 * Exported for its own test: it is pure over bytes, so the check needs no
 * network and no catalogue.
 */
export async function dominantHue(bytes: Buffer): Promise<number | null> {
  const sharp = await loadSharp();
  if (!sharp) return null;

  let pixels: Buffer;
  try {
    // 16px is enough to find a brand colour and cheap enough to run 388 times.
    const out = await sharp(bytes)
      .resize(16, 16, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    pixels = out.data;
  } catch {
    return null;
  }

  // Chroma-weighted histogram: one saturated pixel says more about a logo's
  // colour than a dozen washed-out ones.
  const weights = new Array<number>(BUCKETS).fill(0);
  // Summed as vectors so the winning bucket's hues average across 0°/360°.
  const sinSum = new Array<number>(BUCKETS).fill(0);
  const cosSum = new Array<number>(BUCKETS).fill(0);
  let total = 0;
  let coloured = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue; // transparent — the logo isn't there
    const { a, b } = oklab(pixels[i], pixels[i + 1], pixels[i + 2]);
    const chroma = Math.hypot(a, b);
    if (chroma < MIN_CHROMA) continue; // grey, white or black — no colour

    const radians = Math.atan2(b, a);
    const bucket =
      Math.floor((((radians * 180) / Math.PI + 360) % 360) / (360 / BUCKETS)) %
      BUCKETS;
    weights[bucket] += chroma;
    sinSum[bucket] += Math.sin(radians) * chroma;
    cosSum[bucket] += Math.cos(radians) * chroma;
    total += chroma;
    coloured += 1;
  }

  if (coloured < MIN_COLOURED_PIXELS || total <= 0) return null;

  let winner = 0;
  for (let i = 1; i < BUCKETS; i += 1) if (weights[i] > weights[winner]) winner = i;
  if (weights[winner] / total < MIN_SHARE) return null;

  const hue =
    (Math.atan2(sinSum[winner], cosSum[winner]) * 180) / Math.PI;
  return Math.round((hue + 360) % 360);
}

/**
 * slug → hue, or `null` for "looked, there isn't one". A logo never changes
 * under its slug, so this is computed at most once per process.
 *
 * The value is the in-flight PROMISE, not the number: two concurrent first
 * renders would otherwise fetch and decode the same 386 logos twice.
 */
const memo = new Map<string, Promise<number | null>>();

/** The dominant hue of one template's logo. `logoUrl` is the absolute URL the
 *  catalog client already resolved. */
export function templateAccent(
  slug: string,
  logoUrl: string | null,
): Promise<number | null> {
  const cached = memo.get(slug);
  if (cached) return cached;
  if (!logoUrl) {
    const none = Promise.resolve(null);
    memo.set(slug, none);
    return none;
  }

  const pending = templateImageBytes(logoUrl)
    .then((bytes) => (bytes ? dominantHue(bytes) : null))
    .catch(() => {
      // One bad minute on the catalog must not pin a template to "no colour"
      // for the life of the process.
      memo.delete(slug);
      return null;
    });
  memo.set(slug, pending);
  return pending;
}

/**
 * Accents for a whole catalogue, keyed by slug. Templates with no usable hue
 * are simply absent, so a caller spreads the map and reads `accents[slug]`.
 *
 * Bounded concurrency, and a wall-clock budget: whatever is not resolved in
 * time is left out of this pass and picked up by the next one, rather than
 * holding the page open on a catalogue having a bad day.
 */
export async function templateAccents(
  templates: CatalogTemplate[],
): Promise<Record<string, number>> {
  const settled = new Map<string, number | null>();
  const deadline = Date.now() + BUDGET_MS;
  let next = 0;

  const worker = async () => {
    while (next < templates.length && Date.now() < deadline) {
      const t = templates[next];
      next += 1;
      settled.set(t.slug, await templateAccent(t.slug, t.logo));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, templates.length) }, worker),
  );

  const accents: Record<string, number> = {};
  for (const t of templates) {
    // Only what already resolved: a slug the budget cut short is left out of
    // this pass and picked up by the next render.
    const hue = settled.get(t.slug);
    if (typeof hue === "number") accents[t.slug] = hue;
  }
  return accents;
}
