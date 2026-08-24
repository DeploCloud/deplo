"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AVATAR_ACCEPT_ATTR,
  AVATAR_EDGE_PX,
  AVATAR_IMAGE_TYPES,
  MAX_AVATAR_STRING_LEN,
} from "@/lib/apps/avatar-shared";

/**
 * Change a profile picture by clicking the picture.
 *
 * There is no "Upload" button and no file field: the avatar IS the control, and
 * dropping a file on it works too. Saving happens on PICK, not behind a Save
 * button — the change is one value with no other state to reconcile, so a second
 * step would only be a step. Optimistic, with the previous picture put back if
 * the server refuses.
 *
 * Nothing here knows about Gravatar. `preview` is whatever the server already
 * resolved, and clearing simply hands back null and lets the read path decide
 * what shows next.
 */

/**
 * Downscale to a square and re-encode, in the browser.
 *
 * A centre crop rather than a crop dialog: a profile picture is a face in the
 * middle of a photo often enough that the dialog would be ceremony, and the
 * cheap version is one `drawImage`.
 *
 * WebP at 0.85 puts a 256px square at roughly 20-40 KB. A browser that cannot
 * encode WebP silently answers with a PNG data-URI, which the validator accepts
 * just as happily — so there is no fallback branch to write.
 *
 * This is a CONVENIENCE, never a guarantee: the server re-checks the grammar and
 * the size, because a hostile client simply will not run any of it.
 */
async function toAvatarDataUri(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: "from-image",
  });
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_EDGE_PX;
    canvas.height = AVATAR_EDGE_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context");
    ctx.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_EDGE_PX,
      AVATAR_EDGE_PX,
    );
    return canvas.toDataURL("image/webp", 0.85);
  } finally {
    bitmap.close();
  }
}

export function AvatarPicker({
  preview,
  hasImage,
  onSave,
  disabled,
  label = "Change picture",
}: {
  /** The avatar to render — the caller's own `<UserAvatar>` / `<TeamAvatar>`. */
  preview: React.ReactNode;
  /** Whether there is an uploaded picture to remove. Gravatar is not removable
   *  here: it is not stored, and turning it off is an instance-wide decision. */
  hasImage: boolean;
  onSave: (image: string | null) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();
  const [dragging, setDragging] = React.useState(false);
  const busy = pending || disabled;

  function commit(image: string | null) {
    startTransition(async () => {
      const res = await onSave(image);
      if (res.ok) {
        toast.success(image ? "Picture updated" : "Picture removed");
        router.refresh();
      } else {
        toast.error(res.error ?? "Could not save the picture");
      }
    });
  }

  async function pick(file: File | null | undefined) {
    if (!file || busy) return;
    if (!AVATAR_IMAGE_TYPES.includes(file.type as (typeof AVATAR_IMAGE_TYPES)[number])) {
      toast.error("Unsupported image - use PNG, JPEG or WebP");
      return;
    }
    let dataUri: string;
    try {
      dataUri = await toAvatarDataUri(file);
    } catch {
      toast.error("Could not read that image");
      return;
    }
    // The downscale normally lands two orders of magnitude inside the cap, so
    // this only fires on something pathological - and it is worth saying here
    // rather than letting the server answer for it.
    if (dataUri.length > MAX_AVATAR_STRING_LEN) {
      toast.error("That image is too large");
      return;
    }
    commit(dataUri);
  }

  return (
    <div className="flex items-center gap-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void pick(e.dataTransfer.files?.[0]);
        }}
        aria-label={label}
        className={cn(
          "group relative cursor-pointer rounded-full outline-none transition",
          "focus-visible:ring-2 focus-visible:ring-ring",
          dragging && "ring-2 ring-ring",
          busy && "cursor-not-allowed opacity-60",
        )}
      >
        {preview}
        {/* The affordance: the picture is a control, which nothing about a round
            image says on its own until you are already hovering it. */}
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center rounded-full bg-background/70 opacity-0 transition",
            !busy && "group-hover:opacity-100 group-focus-visible:opacity-100",
            dragging && "opacity-100",
          )}
        >
          <Camera className="size-4 text-foreground" />
        </span>
      </button>
      {hasImage && (
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => commit(null)}
        >
          Remove
        </Button>
      )}
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          void pick(e.target.files?.[0]);
          // Reset so re-picking the same file fires change again.
          e.target.value = "";
        }}
      />
    </div>
  );
}
