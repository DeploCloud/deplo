/**
 * The square crop an image picker drags around, in SOURCE-IMAGE pixels.
 *
 * Deliberately screen-free: the preview canvas and the exported canvas are
 * different sizes, and the one bug a cropper cannot afford is a preview that
 * disagrees with what gets saved. Both ask {@link cropRect} for the same three
 * numbers and hand them straight to `drawImage`.
 *
 * Pure and DOM-free so the arithmetic is unit-tested (`crop-geometry.test.ts`)
 * rather than eyeballed in a browser.
 */

/**
 * What zoom 1 means.
 *
 * `cover` - the biggest square INSIDE the picture, so a profile picture fills
 * the circle at every zoom and can never show transparent bars.
 * `fit` - the smallest square that CONTAINS the picture, so a wide logo is
 * whole at zoom 1 and confirming without touching anything crops nothing.
 */
export type CropMode = "cover" | "fit";

export type CropSource = { width: number; height: number; mode: CropMode };

/** Where the crop square sits: its centre in source pixels, and the zoom. */
export type CropView = { cx: number; cy: number; zoom: number };

/** Never magnify more than this, whatever the picture. */
export const MAX_ZOOM = 8;

/** Nor crop to fewer source pixels than this - past it there is no detail left
 *  to zoom into, only a bigger blur. */
const MIN_CROP_PX = 16;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

/** The crop square's side at zoom 1 - see {@link CropMode}. */
export function baseSize(s: CropSource): number {
  return s.mode === "cover"
    ? Math.min(s.width, s.height)
    : Math.max(s.width, s.height);
}

/** The zoom ceiling for this picture: 8x, or less when the image is so small
 *  that 8x would be magnifying a handful of pixels. Equal to 1 for a tiny
 *  image, which is what tells the slider it has nothing to offer. */
export function maxZoom(s: CropSource): number {
  return clamp(baseSize(s) / MIN_CROP_PX, 1, MAX_ZOOM);
}

/**
 * One axis of the clamp.
 *
 * `lo > hi` is exactly "the crop square is wider than the picture on this
 * axis", i.e. this side is padded - so it is pinned to the middle, because
 * panning could only push the picture out of frame and hand back empty space.
 * A 3:1 logo at zoom 1 has both axes locked and needs no special case anywhere.
 */
function clampAxis(centre: number, span: number, size: number): number {
  const half = size / 2;
  const lo = half;
  const hi = span - half;
  if (lo > hi) return span / 2;
  return clamp(centre, lo, hi);
}

/** The only place the bounds live: wheel, pinch, slider and keyboard all route
 *  through here, so they cannot disagree about what is reachable. */
export function clampView(v: CropView, s: CropSource): CropView {
  const zoom = clamp(v.zoom, 1, maxZoom(s));
  const size = baseSize(s) / zoom;
  return {
    zoom,
    cx: clampAxis(v.cx, s.width, size),
    cy: clampAxis(v.cy, s.height, size),
  };
}

/** Centred, fully zoomed out - what the dialog opens with and what Reset
 *  returns to. */
export function initialView(s: CropSource): CropView {
  return clampView({ cx: s.width / 2, cy: s.height / 2, zoom: 1 }, s);
}

/**
 * What `drawImage` takes as sx, sy and sWidth/sHeight.
 *
 * In `fit` mode sx/sy go NEGATIVE and the square runs past the edge of the
 * picture: the spec clips the source rectangle to the image and the destination
 * rectangle in the same proportion, which is precisely the transparent padding
 * a non-square logo wants. No manual letterboxing.
 */
export function cropRect(v: CropView, s: CropSource) {
  const size = baseSize(s) / v.zoom;
  return { sx: v.cx - size / 2, sy: v.cy - size / 2, size };
}

/** Pan by a drag measured in FRAME pixels. Dragging right moves the picture
 *  right, so the window over it moves left. */
export function panBy(
  v: CropView,
  s: CropSource,
  dxFrame: number,
  dyFrame: number,
  frame: number,
): CropView {
  const k = cropRect(v, s).size / frame; // source px per frame px
  return clampView({ ...v, cx: v.cx - dxFrame * k, cy: v.cy - dyFrame * k }, s);
}

/**
 * Zoom to `next`, holding still whatever sits under (px, py) - each 0..1 across
 * the frame.
 *
 * The slider passes the centre; the wheel and the pinch pass the pointer, and
 * that is the whole difference between zoom that tracks your fingers and zoom
 * that slides away from them. The source x under frame fraction `px` is
 * `cx + (px - 0.5) * size`; holding it fixed across a zoom gives
 * `cx' = cx + (px - 0.5) * (size - size')`.
 */
export function zoomTo(
  v: CropView,
  s: CropSource,
  next: number,
  px = 0.5,
  py = 0.5,
): CropView {
  const zoom = clamp(next, 1, maxZoom(s));
  const d = baseSize(s) / v.zoom - baseSize(s) / zoom;
  return clampView(
    { zoom, cx: v.cx + (px - 0.5) * d, cy: v.cy + (py - 0.5) * d },
    s,
  );
}
