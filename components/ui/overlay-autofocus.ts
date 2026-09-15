"use client";

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let autoFocusing = false;

export function isOverlayAutoFocusing(): boolean {
  return autoFocusing;
}

// Radix focuses the first tabbable on open and Chrome carries :focus-visible over, so a hint icon would open its own tooltip.
export function overlayAutoFocus(event: Event, content: HTMLElement | null) {
  autoFocusing = true;
  setTimeout(() => {
    autoFocusing = false;
  }, 0);
  if (event.defaultPrevented) return;

  const tabbables = content
    ? [...content.querySelectorAll<HTMLElement>(TABBABLE)]
    : [];
  if (!tabbables[0]?.hasAttribute("data-hint-trigger")) return;
  event.preventDefault();
  (
    tabbables.find((el) => !el.hasAttribute("data-hint-trigger")) ?? content
  )?.focus();
}
