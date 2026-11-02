"use client";

import * as React from "react";

const MOBILE = "(max-width: 767.98px)";
const HANDLE_PX = 30;
const CLOSE_PX = 80;
const SLOP_PX = 6;
const TEXT_FIELD = "input, textarea, select, [contenteditable='true']";

/** A drag that ends here closes the sheet: far enough down, or flicked. */
export function dragCloses(dy: number, ms: number): boolean {
  return dy >= CLOSE_PX || (dy > 20 && dy / Math.max(1, ms) > 0.6);
}

/** A touch on the body drags the sheet only going down, mostly vertically, with nothing scrolled under it. */
export function bodyDragStarts(
  dx: number,
  dy: number,
  scrolled: boolean,
): boolean {
  return !scrolled && dy > 0 && dy >= Math.abs(dx);
}

function scrolledBelowTop(from: Element | null, sheet: HTMLElement): boolean {
  for (let n = from; n; n = n.parentElement) {
    if (n.scrollTop > 0) return true;
    if (n === sheet) return false;
  }
  return false;
}

function grabsAtOnce(el: HTMLElement, target: Element, y: number): boolean {
  if (y - el.getBoundingClientRect().top < HANDLE_PX) return true;
  return (
    !!target.closest("[data-sheet-drag]") &&
    !target.closest("button,a,input,textarea,select,[role=button]")
  );
}

function settle(el: HTMLElement) {
  el.style.transition = "transform 200ms ease-out";
  el.style.transform = "";
}

function follow(el: HTMLElement, dy: number) {
  el.style.transform = `translateY(${dy > 0 ? dy : dy / 4}px)`;
}

// A bottom sheet closes when dragged down, as on iOS: from its pill or a [data-sheet-drag] header
// at once, from anywhere else once nothing under the finger is scrolled. It closes through Escape,
// so a sheet that refuses Escape (busy) refuses the drag and the backdrop too.
export function useSheetDrag() {
  const dirty = React.useRef(false);
  const sheet = React.useRef<HTMLElement | null>(null);
  const drag = React.useRef<{ y: number; t: number; id: number } | null>(null);
  const detach = React.useRef<(() => void) | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const close = React.useCallback(() => {
    const el = sheet.current;
    if (!el) return;
    el.style.transition = "transform 180ms ease-in";
    el.style.transform = "translateY(100%)";
    window.setTimeout(() => {
      el.style.animation = "none";
      document.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      window.setTimeout(() => {
        if (!el.isConnected || el.dataset.state !== "open") return;
        el.style.animation = "";
        settle(el);
      }, 60);
    }, 180);
  }, []);

  const release = React.useCallback(
    (el: HTMLElement, dy: number, ms: number) => {
      if (!dragCloses(dy, ms)) return settle(el);
      if (dirty.current) {
        settle(el);
        setConfirmDiscard(true);
        return;
      }
      close();
    },
    [close],
  );

  // Keep it stable: a new callback each render would re-attach and forget that the form changed.
  const ref = React.useCallback(
    (el: HTMLElement | null) => {
      detach.current?.();
      detach.current = null;
      sheet.current = el;
      if (!el) return;
      dirty.current = false;
      setConfirmDiscard(false);
      let touch: { x: number; y: number; t: number; dragging: boolean } | null =
        null;
      let noClickUntil = 0;
      const onStart = (e: TouchEvent) => {
        touch = null;
        const t = e.touches[0];
        const target = e.target as Element;
        if (e.touches.length !== 1 || !window.matchMedia(MOBILE).matches)
          return;
        if (grabsAtOnce(el, target, t.clientY) || target.closest(TEXT_FIELD))
          return;
        touch = { x: t.clientX, y: t.clientY, t: e.timeStamp, dragging: false };
      };
      const onMove = (e: TouchEvent) => {
        if (!touch) return;
        const t = e.touches[0];
        const dx = t.clientX - touch.x;
        const dy = t.clientY - touch.y;
        if (!touch.dragging) {
          if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
          const scrolled = scrolledBelowTop(e.target as Element, el);
          if (!e.cancelable || !bodyDragStarts(dx, dy, scrolled)) {
            touch = null;
            return;
          }
          touch.dragging = true;
          el.style.transition = "none";
        }
        e.preventDefault();
        follow(el, dy);
      };
      const onEnd = (e: TouchEvent) => {
        const d = touch;
        touch = null;
        if (!d?.dragging) return;
        // A menu item selects on pointerup, so the finger lifting off a drag must not choose one.
        noClickUntil = e.timeStamp + 400;
        release(el, e.changedTouches[0].clientY - d.y, e.timeStamp - d.t);
      };
      const onCancel = () => {
        const d = touch;
        touch = null;
        if (d?.dragging) settle(el);
      };
      const onClick = (e: MouseEvent) => {
        if (e.timeStamp > noClickUntil) return;
        e.preventDefault();
        e.stopPropagation();
      };
      el.addEventListener("touchstart", onStart, { passive: true });
      el.addEventListener("touchmove", onMove, { passive: false });
      el.addEventListener("touchend", onEnd);
      el.addEventListener("touchcancel", onCancel);
      el.addEventListener("click", onClick, true);
      detach.current = () => {
        el.removeEventListener("touchstart", onStart);
        el.removeEventListener("touchmove", onMove);
        el.removeEventListener("touchend", onEnd);
        el.removeEventListener("touchcancel", onCancel);
        el.removeEventListener("click", onClick, true);
      };
    },
    [release],
  );

  const handlers = {
    // Only a form can lose something: a search box or a live filter closes without asking.
    onInput: (e: React.FormEvent<HTMLElement>) => {
      if ((e.target as Element).closest("form")) dirty.current = true;
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!window.matchMedia(MOBILE).matches) return;
      const el = e.currentTarget;
      if (!grabsAtOnce(el, e.target as Element, e.clientY)) return;
      sheet.current = el;
      drag.current = { y: e.clientY, t: e.timeStamp, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.style.transition = "none";
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      follow(e.currentTarget, e.clientY - d.y);
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      release(e.currentTarget, e.clientY - d.y, e.timeStamp - d.t);
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      drag.current = null;
      settle(e.currentTarget);
    },
  };

  // A tap on the backdrop closes like a drag does: a form with changes asks first.
  const guardOutside = (event: Event) => {
    if (!dirty.current || !window.matchMedia(MOBILE).matches) return;
    event.preventDefault();
    setConfirmDiscard(true);
  };

  const discard = () => {
    setConfirmDiscard(false);
    dirty.current = false;
    close();
  };

  return {
    ref,
    handlers,
    guardOutside,
    confirmDiscard,
    keepEditing: () => setConfirmDiscard(false),
    discard,
  };
}
