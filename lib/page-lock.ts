/**
 * Freeze the whole page around one view.
 *
 * Some screens own the moment: a migration mid-flight is projects already
 * stopped on the source platform and not yet created here, and the one thing
 * that must not happen is the person wandering off and taking the tab's state
 * with them. A confirm dialog on link clicks is not enough for that - the team
 * switcher is a button that swaps the `deplo_team` cookie and remounts every
 * page under the layout, so it never looked like navigation to a click guard,
 * and it killed the run all the same.
 *
 * So the block is structural rather than per-control: walk from `root` up to
 * the page root and make every SIBLING along the way `inert`. That is the
 * platform's own "this subtree is not part of the interface right now" - no
 * pointer events, no focus, no tab stop, no hit for the "/" hotkey, gone from
 * the accessibility tree - and it covers the sidebar, the topbar with its team
 * switcher and account menu, the banners and the page's own tabs in one pass,
 * including whatever chrome gets added next to them later.
 *
 * Two deliberate limits:
 *
 * - The walk STOPS below `<body>`, so the app shell's siblings stay live: the
 *   toaster (which is how the running view reports what went wrong), the
 *   connection guard, and every dialog or menu Radix portals there. Chrome
 *   menus cannot open anyway, because the triggers that open them are inert.
 * - An element that is ALREADY inert is left alone and never restored, so two
 *   overlapping locks cannot un-freeze each other's work.
 *
 * The dim is not decoration: `inert` changes nothing visually, and a sidebar
 * that silently eats clicks reads as a broken app rather than a held one.
 *
 * Returns the release function. Call it to put the page back.
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
