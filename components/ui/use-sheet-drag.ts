"use client";

import * as React from "react";

const MOBILE = "(max-width: 767.98px)";
const HANDLE_PX = 30;
const CLOSE_PX = 80;

// A bottom sheet closes when dragged down from its pill or a [data-sheet-drag] header.
// It closes through Escape, so a sheet that refuses Escape (busy) refuses the drag too.
export function useSheetDrag() {
  const dirty = React.useRef(false);
  const sheet = React.useRef<HTMLElement | null>(null);
  const drag = React.useRef<{ y: number; t: number; id: number } | null>(null);
  const [confirmDiscard, setConfirmDiscard] = React.useState(false);

  const settle = (el: HTMLElement) => {
    el.style.transition = "transform 200ms ease-out";
    el.style.transform = "";
  };

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

  const handlers = {
    onInput: () => {
      dirty.current = true;
    },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (!window.matchMedia(MOBILE).matches) return;
      const el = e.currentTarget;
      const target = e.target as Element;
      const onHandle = e.clientY - el.getBoundingClientRect().top < HANDLE_PX;
      const onHeader =
        target.closest("[data-sheet-drag]") &&
        !target.closest("button,a,input,textarea,select,[role=button]");
      if (!onHandle && !onHeader) return;
      sheet.current = el;
      drag.current = { y: e.clientY, t: e.timeStamp, id: e.pointerId };
      el.setPointerCapture(e.pointerId);
      el.style.transition = "none";
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      const dy = e.clientY - d.y;
      e.currentTarget.style.transform = `translateY(${dy > 0 ? dy : dy / 4}px)`;
    },
    onPointerUp: (e: React.PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || e.pointerId !== d.id) return;
      drag.current = null;
      const dy = e.clientY - d.y;
      const flick = dy > 20 && dy / Math.max(1, e.timeStamp - d.t) > 0.6;
      if (dy < CLOSE_PX && !flick) return settle(e.currentTarget);
      if (dirty.current) {
        settle(e.currentTarget);
        setConfirmDiscard(true);
        return;
      }
      close();
    },
    onPointerCancel: (e: React.PointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      drag.current = null;
      settle(e.currentTarget);
    },
  };

  const discard = () => {
    setConfirmDiscard(false);
    dirty.current = false;
    close();
  };

  return {
    handlers,
    confirmDiscard,
    keepEditing: () => setConfirmDiscard(false),
    discard,
  };
}
