"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";

/**
 * Parks the text-entry cursor at the END of a prefilled field that gets focused as
 * it appears, otherwise the caret sits BEFORE the value and the first thing typed
 * is prepended to it ("X" + "hello" instead of "hello" + "X").
 */
export function useInitialCaretAtEnd<
  T extends HTMLInputElement | HTMLTextAreaElement,
>(forwardedRef: React.ForwardedRef<T>) {
  const nodeRef = React.useRef<T | null>(null);

  // Forwarding through React rather than hand-composing the two refs: it covers
  // a function ref and an object ref alike, and the assignment stays React's.
  React.useImperativeHandle(forwardedRef, () => nodeRef.current as T, []);

  React.useEffect(() => {
    const el = nodeRef.current;
    // An empty field has nothing to sit in front of.
    if (!el || el.value === "") return;
    parkCaretAtEnd(el);
    const raf = requestAnimationFrame(() => parkCaretAtEnd(el));
    return () => cancelAnimationFrame(raf);
  }, []);

  return nodeRef;
}

/** Input types whose selection is scriptable - `setSelectionRange` throws on the
 *  rest (number, email, date, …). A textarea always is. */
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
