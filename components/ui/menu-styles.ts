// Frosted on desktop, opaque below md. The blur sits on the menu itself: on a ::before it vanishes
// while the menu fades. A submenu is portaled, or the blurred parent would clip it.
export const MENU_SURFACE =
  "rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg md:bg-popover/70 md:backdrop-blur-2xl md:backdrop-saturate-150";

export const MENU_MOTION =
  "duration-150 ease-out data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2";

export const MENU_ITEM =
  "relative flex cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-sm outline-none select-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
