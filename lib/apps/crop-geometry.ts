// CropMode says what zoom 1 means: `cover` is the biggest square inside the picture.
export type CropMode = "cover" | "fit";

export type CropSource = { width: number; height: number; mode: CropMode };

// CropView is where the crop square sits: its centre in source pixels, and the zoom.
export type CropView = { cx: number; cy: number; zoom: number };

// MAX_ZOOM is the hard ceiling on magnification.
export const MAX_ZOOM = 8;

const MIN_CROP_PX = 16;

const clamp = (n: number, lo: number, hi: number) =>
  Math.min(Math.max(n, lo), hi);

// baseSize is the crop square's side at zoom 1.
export function baseSize(s: CropSource): number {
  return s.mode === "cover"
    ? Math.min(s.width, s.height)
    : Math.max(s.width, s.height);
}

// maxZoom is the zoom ceiling for this picture: 8x, or less for a small image.
export function maxZoom(s: CropSource): number {
  return clamp(baseSize(s) / MIN_CROP_PX, 1, MAX_ZOOM);
}

function clampAxis(centre: number, span: number, size: number): number {
  const half = size / 2;
  const lo = half;
  const hi = span - half;
  if (lo > hi) return span / 2;
  return clamp(centre, lo, hi);
}

// clampView is the only place the bounds live, so every input agrees on what is reachable.
export function clampView(v: CropView, s: CropSource): CropView {
  const zoom = clamp(v.zoom, 1, maxZoom(s));
  const size = baseSize(s) / zoom;
  return {
    zoom,
    cx: clampAxis(v.cx, s.width, size),
    cy: clampAxis(v.cy, s.height, size),
  };
}

// initialView is centred and fully zoomed out - what the dialog opens with.
export function initialView(s: CropSource): CropView {
  return clampView({ cx: s.width / 2, cy: s.height / 2, zoom: 1 }, s);
}

// cropRect is what `drawImage` takes as sx, sy and sWidth/sHeight.
export function cropRect(v: CropView, s: CropSource) {
  const size = baseSize(s) / v.zoom;
  return { sx: v.cx - size / 2, sy: v.cy - size / 2, size };
}

// panBy pans by a drag measured in frame pixels.
export function panBy(
  v: CropView,
  s: CropSource,
  dxFrame: number,
  dyFrame: number,
  frame: number,
): CropView {
  const k = cropRect(v, s).size / frame;
  return clampView({ ...v, cx: v.cx - dxFrame * k, cy: v.cy - dyFrame * k }, s);
}

// zoomTo zooms to `next`, holding still whatever sits under (px, py).
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
