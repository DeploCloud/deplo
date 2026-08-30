// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Freeze the whole page around one view. Chrome menus cannot open anyway, because
 * the triggers that open them are inert.
 */
export function lockPageAround(root: Element): () => void {
  const locked: HTMLElement[] = [];

  let node: Element | null = root;
  while (node) {
    const parent: HTMLElement | null = node.parentElement;
    if (!parent || parent === document.body) break;
    for (const sibling of parent.children) {
      if (sibling === node || !(sibling instanceof HTMLElement)) continue;
      if (sibling.inert) continue;
      sibling.inert = true;
      sibling.style.opacity = "0.5";
      locked.push(sibling);
    }
    node = parent;
  }

  return () => {
    for (const el of locked) {
      el.inert = false;
      el.style.removeProperty("opacity");
    }
    locked.length = 0;
  };
}
