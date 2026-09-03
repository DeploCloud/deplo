"use client";

import * as React from "react";

/** True when two sets hold exactly the same members (cheap re-render guard). */
function sameMembers(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface CardSelection {
  /** Currently selected card ids, in the caller's own id space. */
  selected: Set<string>;
  /** Attach to the marquee box element. The hook positions/sizes it imperatively
   *  during a drag (so a pointermove never re-renders the grid); it stays hidden
   *  (display:none) when idle. */
  marqueeRef: React.RefObject<HTMLDivElement | null>;
  /** Attach to the selection canvas: it owns the coordinate space + hit-testing. */
  canvasRef: React.RefObject<HTMLDivElement | null>;
  /** Handle a modifier click on a card. Returns true when it consumed the click
   *  (selection changed → caller should NOT navigate). */
  onItemClick: (
    id: string,
    e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean },
  ) => boolean;
  clear: () => void;
  selectAll: () => void;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
}

/**
 * Windows/macOS-style selection for any card grid (Overview, Storage): a
 * rubber-band marquee over the empty canvas, plus ctrl/cmd-click (toggle) and
 * shift-click (range) on cards.
 */
export function useCardSelection(orderedIds: string[]): CardSelection {
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set());
  const canvasRef = React.useRef<HTMLDivElement | null>(null);
  const marqueeRef = React.useRef<HTMLDivElement | null>(null);
  const anchorRef = React.useRef<string | null>(null);

  // Keep the latest ordered ids + selection readable from the stable imperative
  // handlers below without rebinding them. Synced in an effect (not during render) so
  // the handlers, which only fire after commit, always see current values.
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
      // Not offered as selectable → not selectable by click either.
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
      return false; // plain click → let the card navigate
    },
    [],
  );

  // The marquee starts anywhere in the page area - the whole region right of the
  // sidebar and under the header, gutters and page header included - not only over
  // the grid, so listen on the region rather than on the canvas itself.
  React.useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (e.button !== 0) return; // left button only (right-click -> context menu)
      // Marquee is a mouse/trackpad gesture; on touch a press is a scroll or a
      // long-press context menu, so leave those alone.
      if (e.pointerType !== "mouse") return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const region =
        canvas.closest<HTMLElement>("[data-selection-region]") ?? canvas;
      const target = e.target as HTMLElement;
      // A menu or modal a card opened is portalled to the body: it is outside the
      // region and must never rubber-band the grid underneath it.
      if (!region.contains(target)) return;
      // Presses on a card or any interactive control belong to dnd-kit / the link
      // / the menu, never start a marquee there.
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

      // Snapshot the canvas + every card rect ONCE at press: they don't change during a
      // marquee (no scroll/resize/reflow happens mid-gesture), so the per-move work is
      // just arithmetic, no querySelectorAll and no getBoundingClientRect-per-card
      const crect = canvas.getBoundingClientRect();
      // The box stays inside the region: a drag that runs past it must not paint
      // over the sidebar.
      const rrect = region.getBoundingClientRect();
      const cardRects: { id: string; r: DOMRect }[] = [];
      // Only ids the caller offered: a card it left out is one it will not act on
      // (a row a migration is still writing), and the marquee is the one path that
      // could still put it in the selection.
      const selectable = new Set(idsRef.current);
      canvas.querySelectorAll<HTMLElement>("[data-card-id]").forEach((el) => {
        const id = el.getAttribute("data-card-id");
        if (id && selectable.has(id))
          cardRects.push({ id, r: el.getBoundingClientRect() });
      });

      // The 4px threshold gates only the START (so a plain click stays a click).
      // Once a drag has begun, every move recomputes, even back under 4px, so
      // the box and selection collapse correctly if the user drags back to origin.
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
          // The region holds prose the canvas' own select-none doesn't cover;
          // drop what the first few pixels highlighted and stop it growing.
          region.style.userSelect = "none";
          window.getSelection()?.removeAllRanges();
        }
        // Position the box imperatively - no setState, so the grid and its N cards
        // are NOT re-rendered on every pointermove.
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
        // Skip the re-render (and the cascade to every card) when the hit set is
        // unchanged from the last move - common while dragging within one cell.
        setSelected((prev) => (sameMembers(prev, hit) ? prev : hit));
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        region.style.userSelect = "";
        if (marqueeRef.current) marqueeRef.current.style.display = "none";
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    }
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
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
