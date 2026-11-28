// Frosted on desktop, an opaque action sheet below md. The blur lives on ::before and the open
// animation is off, because an ancestor fading through opacity would flatten the blur.
export const MENU_SURFACE =
  "relative rounded-2xl border border-border bg-popover p-1.5 text-popover-foreground shadow-lg md:animate-none! md:bg-popover/70 md:before:pointer-events-none md:before:absolute md:before:inset-0 md:before:-z-1 md:before:rounded-[inherit] md:before:backdrop-blur-2xl md:before:backdrop-saturate-150";

export const MENU_ITEM =
  "relative flex cursor-pointer items-center gap-2.5 rounded-xl px-3 py-2 text-sm outline-none select-none focus:bg-accent data-[disabled]:pointer-events-none data-[disabled]:opacity-50";
