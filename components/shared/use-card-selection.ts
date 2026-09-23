"use client";

import * as React from "react";

function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface CardSelection {
  selected: Set<string>;
  marqueeRef: React.RefObject<HTMLDivElement | null>;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  onItemClick: (
    id: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => boolean;
  clear: () => void;
  selectAll: () => void;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
}

export function useCardSelection(orderedIds: string[]): CardSelection {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const marqueeRef = React.useRef<HTMLDivElement | null>(null);
  const anchorRef = React.useRef<string | null>(null);

  const idsRef = React.useRef(orderedIds);
  const selectedRef = React.useRef(selected);
  React.useEffect(() => {
    idsRef.current = orderedIds;
    selectedRef.current = selected;
  });

  const clear = React.useCallback(() => {
    anchorRef.current = null;
    setSelected(new Set());
  }, []);

  const selectAll = React.useCallback(() => {
    setSelected(new Set(idsRef.current));
  }, []);

  const onItemClick = React.useCallback(
    (
      id: string,
      e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
    ): boolean => {
      if (!idsRef.current.includes(id)) return false;
      if (e.shiftKey) {
        const ids = idsRef.current;
        const anchor = anchorRef.current ?? id;
        const a = ids.indexOf(anchor);
        const b = ids.indexOf(id);
        setSelected((prev) => {
          const next = new Set(prev);
          if (a < 0 || b < 0) {
            next.add(id);
            return next;
          }
          const [lo, hi] = a < b ? [a, b] : [b, a];
          for (let i = lo; i <= hi; i++) next.add(ids[i]);
          return next;
        });
        return true;
      }
      if (e.metaKey || e.ctrlKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        });
        anchorRef.current = id;
        return true;
      }
      return false;
    },
    [],
  );

  React.useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return;
      if (e.pointerType !== "mouse") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const region =
        canvas.closest<HTMLElement>("[data-selection-region]") ?? canvas;
      const target = e.target as HTMLElement;
      if (!region.contains(target)) return;
      if (
        target.closest("[data-card-id]") ||
        target.closest("[data-card-actions]") ||
        target.closest("[data-selection-bar]") ||
        target.closest(
          "a, button, input, textarea, select, label, [role='menuitem'], [role='tab'], [role='combobox'], [contenteditable='true']",
        )
      ) {
        return;
      }

      const additive = e.metaKey || e.ctrlKey || e.shiftKey;
      const base = additive ? new Set(selectedRef.current) : new Set<string>();
      const startX = e.clientX;
      const startY = e.clientY;
      if (!additive) setSelected(new Set());

      const crect = canvas.getBoundingClientRect();
      const rrect = region.getBoundingClientRect();
      const cardRects: { id: string; r: DOMRect }[] = [];
      const selectable = new Set(idsRef.current);
      canvas.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
        const id = el.getAttribute("data-card-id");
        if (id && selectable.has(id))
          cardRects.push({ id, r: el.getBoundingClientRect() });
      });

      let started = false;
      const onMove = (ev: PointerEvent) => {
        const px = Math.min(Math.max(ev.clientX, rrect.left), rrect.right);
        const py = Math.min(Math.max(ev.clientY, rrect.top), rrect.bottom);
        const x1 = Math.min(startX, px);
        const x2 = Math.max(startX, px);
        const y1 = Math.min(startY, py);
        const y2 = Math.max(startY, py);
        if (!started && x2 - x1 < 4 && y2 - y1 < 4) return;
        if (!started) {
          started = true;
          region.style.userSelect = "none";
          window.getSelection()?.removeAllRanges();
        }
        const box = marqueeRef.current;
        if (box) {
          box.style.display = "block";
          box.style.left = `${x1 - crect.left}px`;
          box.style.top = `${y1 - crect.top}px`;
          box.style.width = `${x2 - x1}px`;
          box.style.height = `${y2 - y1}px`;
        }
        const hit = new Set(base);
        for (const { id, r } of cardRects) {
          if (r.left < x2 && r.right > x1 && r.top < y2 && r.bottom > y1) {
            hit.add(id);
          }
        }
        setSelected((prev) => (sameMembers(prev, hit) ? prev : hit));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        region.style.userSelect = "";
        if (marqueeRef.current) marqueeRef.current.style.display = "none";
        if (endDrag === onUp) endDrag = null;
      };
      endDrag?.();
      endDrag = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    }
    let endDrag: (() => void) | null = null;
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      endDrag?.();
    };
  }, []);

  return {
    selected,
    marqueeRef,
    canvasRef,
    onItemClick,
    clear,
    selectAll,
    setSelected,
  };
}
