import "server-only";

import { templateImageBytes } from "@/templates/catalog";
import type { CatalogTemplate } from "@/templates/types";

const MIN_CHROMA = 0.04;
const BUCKETS = 24;
const MIN_SHARE = 0.15;
const MIN_COLOURED_PIXELS = 4;
const MID_LIGHTNESS = 0.5;

const CONCURRENCY = 16;
const BUDGET_MS = 8000;

type Sharp = (typeof import("sharp"))["default"];
let sharpModule: Promise<Sharp | null> | undefined;
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp").then((m) => m.default).catch(() => null);
  return sharpModule;
}

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

export interface LogoAccent {
  hue?: number;
  tone?: "dark" | "light";
}

export async function analyseLogo(bytes: Buffer): Promise<LogoAccent> {
  const sharp = await loadSharp();
  if (!sharp) return {};

  let pixels: Buffer;
  try {
    const out = await sharp(bytes)
      .resize(16, 16, { fit: "inside" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    pixels = out.data;
  } catch {
    return {};
  }

  const weights = new Array<number>(BUCKETS).fill(0);
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
    return { hue: Math.round((hue + 360) % 360) };
  }

  if (black > white) return { tone: "dark" };
  if (white > black) return { tone: "light" };
  return {};
}

const memo = new Map<string, Promise<LogoAccent>>();

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
      memo.delete(slug);
      return {};
    });
  memo.set(slug, pending);
  return pending;
}

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
    const accent = settled.get(t.slug);
    if (accent && (accent.hue !== undefined || accent.tone !== undefined))
      accents[t.slug] = accent;
  }
  return accents;
}
