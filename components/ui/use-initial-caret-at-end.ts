"use client";

import * as React from "react";

/**
 * Parks the text-entry cursor at the END of a prefilled field that gets focused
 * as it appears — otherwise the caret sits BEFORE the value and the first thing
 * typed is prepended to it ("X" + "hello" instead of "hello" + "X").
 *
 * Why it happens: a text control's cursor starts at index 0 and only moves when
 * something moves it, and `focus()` is not something that moves it. Assigning
 * `.value` from JS *is* (the spec has the setter "move the text entry cursor
 * position to the end"), which is why a prefilled `<input>` usually looks right —
 * React mounts it empty and then assigns the value. A `<textarea>` is mounted
 * with its value ALREADY in place as the element's text content, so React's
 * follow-up assignment writes the string the element already holds, the browser
 * skips it as a no-op, and the cursor never leaves 0. Hydrated markup does the
 * same to an `<input>`, whose value then arrives as an attribute.
 *
 * Both ways a field is focused as it appears are covered: React's `autoFocus`
 * (already fired by the time this hook's own mount effect runs) and Radix's
 * focus-the-first-tabbable-element when a Dialog/Sheet opens (an ancestor's
 * effect, so it lands a frame later — hence the second pass).
 *
 * Deliberately narrow, so it only ever fixes the broken case:
 * - the field must actually hold the focus — we never yank a caret into a field
 *   that is merely on screen;
 * - its selection must still be the untouched 0/0 — Radix selects an input's
 *   whole value when it does the focusing, and that (like anything else that
 *   placed a caret on purpose) is left exactly as it is;
 * - it runs on mount only, so a field the user clicks or tabs into later keeps
 *   the caret where they put it.
 *
 * Returns the ref to hand the element; the caller's own forwarded ref still gets
 * the node.
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

/** Input types whose selection is scriptable — `setSelectionRange` throws on the
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
