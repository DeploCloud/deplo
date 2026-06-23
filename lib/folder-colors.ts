/**
 * The curated accent colours offered for a folder tile, alongside a free-form
 * custom HEX. Values are Tailwind's 500-weight swatches so a chosen folder reads
 * as part of the same palette as the rest of the dashboard. The readable
 * foreground for each is derived at render time (see `readableTextColor`), never
 * stored, so the list is purely the background choices.
 */
export interface FolderColor {
  /** Human label shown as the swatch's tooltip / aria-label. */
  name: string;
  /** Canonical lowercase `#rrggbb`. */
  value: string;
}

export const FOLDER_COLORS: FolderColor[] = [
  { name: "Slate", value: "#64748b" },
  { name: "Red", value: "#ef4444" },
  { name: "Orange", value: "#f97316" },
  { name: "Amber", value: "#f59e0b" },
  { name: "Lime", value: "#84cc16" },
  { name: "Green", value: "#22c55e" },
  { name: "Emerald", value: "#10b981" },
  { name: "Teal", value: "#14b8a6" },
  { name: "Sky", value: "#0ea5e9" },
  { name: "Blue", value: "#3b82f6" },
  { name: "Indigo", value: "#6366f1" },
  { name: "Violet", value: "#8b5cf6" },
  { name: "Fuchsia", value: "#d946ef" },
  { name: "Pink", value: "#ec4899" },
  { name: "Rose", value: "#f43f5e" },
];
