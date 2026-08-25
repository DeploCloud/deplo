"use client";

/**
 * What every overlay does with focus on the way in. Radix focuses the first
 * tabbable element, which lands the user on an info icon they cannot act on -
 * and opens its tooltip, since Chrome carries `:focus-visible` over.
 */

/** What Radix treats as a focus candidate when a surface opens. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let autoFocusing = false;

/**
 * True for the instant an overlay is moving focus into itself. Radix focuses
 * synchronously right after the open event and React dispatches focus in the
 * same task, so one macrotask is a precise window, not a guess.
 */
export function isOverlayAutoFocusing(): boolean {
  return autoFocusing;
}

/**
 * The `onOpenAutoFocus` shared by every overlay. Call it AFTER the caller's own
 * handler so a surface that places focus itself still wins. `content` scopes the
 * search, so a nested overlay never reaches into its parent.
 */
export function overlayAutoFocus(event: Event, content: HTMLElement | null) {
  autoFocusing = true;
  setTimeout(() => {
    autoFocusing = false;
  }, 0);
  if (event.defaultPrevented) return;

  const tabbables = content
    ? [...content.querySelectorAll<HTMLElement>(TABBABLE)]
    : [];
  // Only step in when the first candidate is a hint. Radix's default — focus the
  // first real field, so the user can type straight away — is what we want
  // everywhere else, and Enter-to-submit depends on it.
  if (!tabbables[0]?.hasAttribute("data-hint-trigger")) return;
  event.preventDefault();
  (
    tabbables.find((el) => !el.hasAttribute("data-hint-trigger")) ?? content
  )?.focus();
}
