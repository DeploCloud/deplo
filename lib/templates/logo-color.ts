import "server-only";

import { templateImageBytes } from "@/templates/catalog";
import type { CatalogTemplate } from "@/templates/types";

// Below this OKLCH chroma a pixel is grey, white or black - it has no colour.
const MIN_CHROMA = 0.04;
// 15° buckets. Finer splits a single brand colour across two neighbours.
const BUCKETS = 24;
// A hue nobody would name: too few coloured pixels to be the logo's colour.
const MIN_SHARE = 0.15;
const MIN_COLOURED_PIXELS = 4;
// Neutral ink below this OKLab lightness is "black", above it is "white".
const MID_LIGHTNESS = 0.5;

const CONCURRENCY = 16;
// ADR-0023: the catalogue degrades, it does not error - a cold pass renders untinted.
const BUDGET_MS = 8000;

// A native module that will not load must not take the Templates section down: no tints.
type Sharp = (typeof import("sharp"))["default"];
let sharpModule: Promise<Sharp | null> | undefined;
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp").then((m) => m.default).catch(() => null);
  return sharpModule;
}

// sRGB 0-255 → OKLab, the transform the oklch() in globals.css inverts.
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
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

// LogoAccent - what a card needs to draw a logo well; tone is the theme it would vanish into.
export interface LogoAccent {
  hue?: number;
  tone?: "dark" | "light";
}

// analyseLogo - read an image once and answer both; exported pure over bytes for its own test.
export async function analyseLogo(bytes: Buffer): Promise<LogoAccent> {
  const sharp = await loadSharp();
  if (!sharp) return {};

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
    return {};
  }

  // Chroma-weighted: one saturated pixel says more than a dozen washed-out ones.
  const weights = new Array<number>(BUCKETS).fill(0);
  // Summed as vectors so the winning bucket's hues average across 0°/360°.
  const sinSum = new Array<number>(BUCKETS).fill(0);
  const cosSum = new Array<number>(BUCKETS).fill(0);
  let total = 0;
  let coloured = 0;
  let black = 0;
  let white = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    if (pixels[i + 3] < 128) continue;
    const { L, a, b } = oklab(pixels[i], pixels[i + 1], pixels[i + 2]);
    const chroma = Math.hypot(a, b);
    if (chroma < MIN_CHROMA) {
      // Neutral: no colour, but this ink decides whether the logo is visible at all.
      if (L < MID_LIGHTNESS) black += 1;
      else white += 1;
      continue;
    }

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

  let winner = 0;
  for (let i = 1; i < BUCKETS; i += 1)
    if (weights[i] > weights[winner]) winner = i;
  const hasHue =
    coloured >= MIN_COLOURED_PIXELS &&
    total > 0 &&
    weights[winner] / total >= MIN_SHARE;

  if (hasHue) {
    const hue = (Math.atan2(sinSum[winner], cosSum[winner]) * 180) / Math.PI;
    // Chroma carries a coloured logo on both surfaces, so it never needs a plate.
    return { hue: Math.round((hue + 360) % 360) };
  }

  // A wordmark in one neutral disappears into the side it is drawn on.
  if (black > white) return { tone: "dark" };
  if (white > black) return { tone: "light" };
  return {};
}

// slug → accent: a logo never changes under its slug, so it is read once per process.
const memo = new Map<string, Promise<LogoAccent>>();

// templateAccent - one template's logo, read; logoUrl is the URL the catalog client resolved.
export function templateAccent(
  slug: string,
  logoUrl: string | null,
): Promise<LogoAccent> {
  const cached = memo.get(slug);
  if (cached) return cached;
  if (!logoUrl) {
    const none = Promise.resolve({});
    memo.set(slug, none);
    return none;
  }

  const pending = templateImageBytes(logoUrl)
    .then((bytes) => (bytes ? analyseLogo(bytes) : {}))
    .catch(() => {
      // One bad minute on the catalog must not pin a template to "no colour" for life.
      memo.delete(slug);
      return {};
    });
  memo.set(slug, pending);
  return pending;
}

// templateAccents - accents for a whole catalogue, keyed by slug.
export async function templateAccents(
  templates: CatalogTemplate[],
): Promise<Record<string, LogoAccent>> {
  const settled = new Map<string, LogoAccent>();
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

  const accents: Record<string, LogoAccent> = {};
  for (const t of templates) {
    // A slug the budget cut short is left out and picked up by the next render.
    const accent = settled.get(t.slug);
    if (accent && (accent.hue !== undefined || accent.tone !== undefined))
      accents[t.slug] = accent;
  }
  return accents;
}
