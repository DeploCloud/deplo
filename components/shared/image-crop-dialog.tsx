"use client";

import * as React from "react";
import { toast } from "sonner";
import { ZoomIn, ZoomOut } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { AVATAR_EDGE_PX } from "@/lib/apps/avatar-shared";
import {
  CROPPABLE_LOGO_TYPES,
  isAnimatedWebp,
  LOGO_EDGE_PX,
} from "@/lib/apps/logo-shared";
import {
  cropRect,
  initialView,
  maxZoom,
  panBy,
  zoomTo,
  type CropSource,
  type CropView,
} from "@/lib/apps/crop-geometry";

const WORK_EDGE_PX = 2048;

const PREVIEW_PX = 640;

export async function isCroppableLogo(file: File): Promise<boolean> {
  if (
    !CROPPABLE_LOGO_TYPES.includes(
      file.type as (typeof CROPPABLE_LOGO_TYPES)[number],
    )
  )
    return false;
  if (file.type !== "image/webp") return true;
  try {
    return !isAnimatedWebp(
      new Uint8Array(await file.slice(0, 21).arrayBuffer()),
    );
  } catch {
    return false;
  }
}

export function ImageCropDialog({
  file,
  variant = "avatar",
  onClose,
  onCropped,
}: {
  file: File | null;
  variant?: "avatar" | "logo";
  onClose: () => void;
  onCropped: (dataUri: string) => void;
}) {
  const mode = variant === "avatar" ? "cover" : "fit";
  const edge = variant === "avatar" ? AVATAR_EDGE_PX : LOGO_EDGE_PX;
  const zoomId = React.useId();

  const surfaceRef = React.useRef<HTMLDivElement>(null);
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const bitmapRef = React.useRef<ImageBitmap | null>(null);
  const srcRef = React.useRef<CropSource | null>(null);
  const viewRef = React.useRef<CropView>({ cx: 0, cy: 0, zoom: 1 });
  const [decoded, setDecoded] = React.useState<{
    file: File;
    source: CropSource;
  } | null>(null);
  const [zoom, setZoom] = React.useState(1);
  const src = decoded?.file === file ? decoded.source : null;

  const draw = React.useCallback(() => {
    const bmp = bitmapRef.current;
    const cv = canvasRef.current;
    const s = srcRef.current;
    if (!bmp || !cv || !s) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    const { sx, sy, size } = cropRect(viewRef.current, s);
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.drawImage(bmp, sx, sy, size, size, 0, 0, cv.width, cv.height);
  }, []);

  const apply = React.useCallback(
    (next: CropView) => {
      viewRef.current = next;
      draw();
      setZoom(next.zoom);
    },
    [draw],
  );

  React.useEffect(() => {
    if (!file) return;
    let cancelled = false;
    void (async () => {
      try {
        let bmp = await createImageBitmap(file, {
          imageOrientation: "from-image",
        });
        const long = Math.max(bmp.width, bmp.height);
        if (long > WORK_EDGE_PX) {
          const k = WORK_EDGE_PX / long;
          const small = await createImageBitmap(bmp, {
            resizeWidth: Math.round(bmp.width * k),
            resizeHeight: Math.round(bmp.height * k),
            resizeQuality: "high",
          });
          bmp.close();
          bmp = small;
        }
        if (cancelled) {
          bmp.close();
          return;
        }
        bitmapRef.current = bmp;
        const s: CropSource = { width: bmp.width, height: bmp.height, mode };
        srcRef.current = s;
        setDecoded({ file, source: s });
        apply(initialView(s));
      } catch {
        if (cancelled) return;
        toast.error("Could not read that image");
        onClose();
      }
    })();
    return () => {
      cancelled = true;
      bitmapRef.current?.close();
      bitmapRef.current = null;
      srcRef.current = null;
      setDecoded(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, mode, apply]);

  React.useEffect(() => {
    const el = surfaceRef.current;
    if (!el || !src) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.03 : 0.002));
      apply(
        zoomTo(
          viewRef.current,
          src,
          viewRef.current.zoom * f,
          (e.clientX - r.left) / r.width,
          (e.clientY - r.top) / r.height,
        ),
      );
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [src, apply]);

  const pointersRef = React.useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = React.useRef(0);

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    const s = srcRef.current;
    if (!s) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const pts = pointersRef.current;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size > 1) {
      pinchRef.current = 0;
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();

    const onMove = (ev: PointerEvent) => {
      const prev = pts.get(ev.pointerId);
      if (!prev) return;
      const dx = ev.clientX - prev.x;
      const dy = ev.clientY - prev.y;
      pts.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const two = [...pts.values()];
      if (two.length >= 2) {
        const dist = Math.hypot(two[0].x - two[1].x, two[0].y - two[1].y);
        if (pinchRef.current > 0) {
          const mx = (two[0].x + two[1].x) / 2;
          const my = (two[0].y + two[1].y) / 2;
          apply(
            zoomTo(
              viewRef.current,
              s,
              viewRef.current.zoom * (dist / pinchRef.current),
              (mx - rect.left) / rect.width,
              (my - rect.top) / rect.height,
            ),
          );
        }
        pinchRef.current = dist;
        return;
      }
      apply(panBy(viewRef.current, s, dx, dy, rect.width));
    };
    const onEnd = (ev: PointerEvent) => {
      pts.delete(ev.pointerId);
      pinchRef.current = 0;
      if (pts.size > 0) return;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const s = srcRef.current;
    const el = surfaceRef.current;
    if (!s || !el) return;
    const step = e.shiftKey ? 64 : 16;
    const frame = el.getBoundingClientRect().width;
    const pan = (dx: number, dy: number) =>
      apply(panBy(viewRef.current, s, dx, dy, frame));
    switch (e.key) {
      case "ArrowLeft":
        pan(-step, 0);
        break;
      case "ArrowRight":
        pan(step, 0);
        break;
      case "ArrowUp":
        pan(0, -step);
        break;
      case "ArrowDown":
        pan(0, step);
        break;
      case "+":
      case "=":
        apply(zoomTo(viewRef.current, s, viewRef.current.zoom * 1.2));
        break;
      case "-":
        apply(zoomTo(viewRef.current, s, viewRef.current.zoom / 1.2));
        break;
      default:
        return;
    }
    e.preventDefault();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const bmp = bitmapRef.current;
    const s = srcRef.current;
    if (!bmp || !s) return;
    try {
      const canvas = document.createElement("canvas");
      canvas.width = edge;
      canvas.height = edge;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      const { sx, sy, size } = cropRect(viewRef.current, s);
      ctx.drawImage(bmp, sx, sy, size, size, 0, 0, edge, edge);
      onCropped(canvas.toDataURL("image/webp", 0.85));
    } catch {
      toast.error("Could not read that image");
    }
  }

  const max = src ? maxZoom(src) : 1;

  return (
    <Dialog
      open={file !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Crop image</DialogTitle>
          <DialogDescription>Drag to move, scroll to zoom.</DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="mx-auto w-full max-w-80">
            <div
              ref={surfaceRef}
              role="group"
              tabIndex={0}
              aria-label="Crop area"
              onPointerDown={onPointerDown}
              onKeyDown={onKeyDown}
              className="relative aspect-square w-full cursor-move touch-none overflow-hidden rounded-lg bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <canvas
                ref={canvasRef}
                width={PREVIEW_PX}
                height={PREVIEW_PX}
                className="size-full"
              />
              <div className="pointer-events-none absolute inset-y-0 left-1/3 w-1/3 border-x border-ring" />
              <div className="pointer-events-none absolute inset-x-0 top-1/3 h-1/3 border-y border-ring" />
              <div
                className={cn(
                  "pointer-events-none absolute inset-0 shadow-[0_0_0_9999px_var(--card)] ring-1 ring-border",
                  variant === "avatar" ? "rounded-full" : "rounded-lg",
                )}
              />
            </div>
          </div>
          <div className="mx-auto flex w-full max-w-80 items-center gap-3">
            <Label htmlFor={zoomId} className="sr-only">
              Zoom
            </Label>
            <ZoomOut className="size-4 shrink-0 text-muted-foreground" />
            <input
              id={zoomId}
              type="range"
              min={1}
              max={max}
              step={0.01}
              value={zoom}
              disabled={!src || max <= 1}
              aria-valuetext={`${Math.round(zoom * 100)}%`}
              onChange={(e) =>
                src &&
                apply(zoomTo(viewRef.current, src, Number(e.target.value)))
              }
              className="h-9 flex-1 accent-primary"
            />
            <ZoomIn className="size-4 shrink-0 text-muted-foreground" />
          </div>
          <DialogFooter>
            <Button
              variant="ghost"
              className="text-muted-foreground"
              disabled={!src}
              onClick={() => src && apply(initialView(src))}
            >
              Reset
            </Button>
            <div className="flex flex-col-reverse gap-2 sm:flex-row">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!src}>
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
