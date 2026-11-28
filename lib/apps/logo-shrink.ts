import "server-only";

import { isAnimatedWebp } from "./logo-shared";

const EDGE_PX = 128;
// A small SVG stays vector; a large one is almost always a raster wrapped in SVG.
const SVG_KEEP_BYTES = 16 * 1024;
const DATA_URI = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+=*)$/;

type Sharp = (typeof import("sharp"))["default"];
let sharpModule: Promise<Sharp | null> | undefined;
function loadSharp(): Promise<Sharp | null> {
  sharpModule ??= import("sharp").then((m) => m.default).catch(() => null);
  return sharpModule;
}

/** The logo at the size it is ever shown (128 px WebP), or unchanged when that would not make it smaller. */
export async function shrinkLogo(logo: string): Promise<string> {
  const m = DATA_URI.exec(logo);
  if (!m) return logo;
  const type = m[1]!;
  const bytes = Buffer.from(m[2]!, "base64");
  const svg = type === "image/svg+xml";
  const raster =
    type === "image/png" ||
    type === "image/jpeg" ||
    (type === "image/webp" && !isAnimatedWebp(bytes.subarray(0, 32)));
  if (!raster && !(svg && bytes.length > SVG_KEEP_BYTES)) return logo;

  const sharp = await loadSharp();
  if (!sharp) return logo;
  try {
    // Already its final shape: encoding it again would only lose quality.
    if (type === "image/webp") {
      const { width = 0, height = 0 } = await sharp(bytes).metadata();
      if (width <= EDGE_PX && height <= EDGE_PX) return logo;
    }
    const out = await sharp(bytes, svg ? { density: 300 } : undefined)
      .resize(EDGE_PX, EDGE_PX, { fit: "inside", withoutEnlargement: !svg })
      .webp({ quality: 90 })
      .toBuffer();
    return out.length < bytes.length
      ? `data:image/webp;base64,${out.toString("base64")}`
      : logo;
  } catch {
    return logo;
  }
}
