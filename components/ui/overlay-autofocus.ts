"use client";

/**
 * What every overlay that opens over the page — Dialog, Sheet, Popover — does
 * with focus on the way in, in one place, because the two problems below are
 * properties of "a surface opened itself", not of any one dialog.
 *
 * 1. Radix focuses the surface's first tabbable element. When that element is an
 *    info icon the user lands on a control they cannot act on, ringed as if they
 *    had tabbed to it deliberately.
 * 2. Radix Tooltip opens on ANY focus of its trigger, so that same auto-focus
 *    made a dialog come up with a tooltip already floating over it — and
 *    `:focus-visible` does not filter it out, because Chrome carries
 *    focus-visible over from the element that had it (the ⋯ menu item you just
 *    clicked) to whatever is focused programmatically next.
 */

/** What Radix treats as a focus candidate when a surface opens. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

let autoFocusing = false;

/**
 * True for the instant an overlay is moving focus into itself as it opens — the
 * one focus change the user never asked for. Radix focuses synchronously right
 * after dispatching the open event, and React dispatches focus (a discrete
 * event) in the same task, so one macrotask is a precise window, not a guess.
 */
export function isOverlayAutoFocusing(): boolean {
  return autoFocusing;
}

/**
 * The `onOpenAutoFocus` shared by every overlay surface. Call it AFTER the
 * caller's own handler so a surface that wants to place focus itself still wins
 * (it prevents default, and this leaves it alone).
 *
 * `content` is the surface element — the search for a real control is scoped to
 * it, so a nested overlay never reaches into its parent.
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
