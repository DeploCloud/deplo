"use client";

import * as React from "react";

export function useInitialCaretAtEnd<
  T extends HTMLInputElement | HTMLTextAreaElement,
>(forwardedRef: React.ForwardedRef<T>) {
  const nodeRef = React.useRef<T | null>(null);

  React.useImperativeHandle(forwardedRef, () => nodeRef.current as T, []);

  React.useEffect(() => {
    const el = nodeRef.current;
    if (!el || el.value === "") return;
    parkCaretAtEnd(el);
    const raf = requestAnimationFrame(() => parkCaretAtEnd(el));
    return () => cancelAnimationFrame(raf);
  }, []);

  return nodeRef;
}

// setSelectionRange throws on every other input type (number, email, date); a textarea always allows it.
const SELECTABLE_INPUT_TYPES = new Set([
  "text",
  "search",
  "url",
  "tel",
  "password",
]);

function parkCaretAtEnd(el: HTMLInputElement | HTMLTextAreaElement) {
  if (document.activeElement !== el) return;
  if (el instanceof HTMLInputElement && !SELECTABLE_INPUT_TYPES.has(el.type))
    return;
  if (el.selectionStart !== 0 || el.selectionEnd !== 0) return;
  const end = el.value.length;
  el.setSelectionRange(end, end);
}
