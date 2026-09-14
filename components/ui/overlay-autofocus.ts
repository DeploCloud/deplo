"use client";

// Radix focuses the first tabbable element on open - an info icon the user cannot act on, whose tooltip then shows because Chrome carries `:focus-visible` over.

// What Radix treats as a focus candidate when a surface opens.
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let autoFocusing = false;

// isOverlayAutoFocusing is true while an overlay moves focus into itself: Radix focuses synchronously after the open event, so one macrotask is an exact window.
export function isOverlayAutoFocusing(): boolean {
  return autoFocusing;
}

// overlayAutoFocus is the shared `onOpenAutoFocus`: call it AFTER the caller's own handler, and `content` scopes the search so a nested overlay never reaches its parent.
export function overlayAutoFocus(event: Event, content: HTMLElement | null) {
  autoFocusing = true;
  setTimeout(() => {
    autoFocusing = false;
  }, 0);
  if (event.defaultPrevented) return;

  const tabbables = content
    ? [...content.querySelectorAll<HTMLElement>(TABBABLE)]
    : [];
  // Only step in when the first candidate is a hint: Radix's default (focus the first real field) is wanted everywhere else, and Enter-to-submit depends on it.
  if (!tabbables[0]?.hasAttribute("data-hint-trigger")) return;
  event.preventDefault();
  (
    tabbables.find((el) => !el.hasAttribute("data-hint-trigger")) ?? content
  )?.focus();
}
