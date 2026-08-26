"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  AVATAR_ACCEPT_ATTR,
  AVATAR_IMAGE_TYPES,
  MAX_AVATAR_STRING_LEN,
} from "@/lib/apps/avatar-shared";
import { ImageCropDialog } from "@/components/shared/image-crop-dialog";

/**
 * Change a profile picture by clicking the picture. Picking opens the crop dialog,
 * and confirming there saves - there is no Save button after it, because the
 * change is one value with no other state to reconcile.
 */

export function AvatarPicker({
  preview,
  hasImage,
  onSave,
  disabled,
  label = "Change picture",
  children,
}: {
  /** The avatar to render - the caller's own `<UserAvatar>` / `<TeamAvatar>`. */
  preview: React.ReactNode;
  /** Whether there is an uploaded picture to remove. Gravatar is not removable
   *  here: it is not stored, and turning it off is an instance-wide decision. */
  hasImage: boolean;
  onSave: (image: string | null) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  label?: string;
  /** What sits beside the picture. Remove lands under it. */
  children?: React.ReactNode;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();
  const [dragging, setDragging] = React.useState(false);
  const [picked, setPicked] = React.useState<File | null>(null);
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

  function pick(file: File | null | undefined) {
    if (!file || busy) return;
    if (
      !AVATAR_IMAGE_TYPES.includes(
        file.type as (typeof AVATAR_IMAGE_TYPES)[number],
      )
    ) {
      toast.error("Unsupported image - use PNG, JPEG or WebP");
      return;
    }
    setPicked(file);
  }

  return (
    <div className="flex items-center gap-4">
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
          pick(e.dataTransfer.files?.[0]);
        }}
        aria-label={label}
        className={cn(
          "group relative cursor-pointer rounded-full transition outline-none",
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
        {/* Always on: without it a round picture is just a picture until the
            pointer happens to land on it, and a touch screen never hovers. */}
        <span className="absolute right-0 bottom-0 flex size-5 items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground">
          <Camera className="size-2.5" />
        </span>
      </button>
      <div className="min-w-0 space-y-2">
        {children}
        {hasImage && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => commit(null)}
          >
            Remove
          </Button>
        )}
      </div>
      <ImageCropDialog
        file={picked}
        variant="avatar"
        onClose={() => setPicked(null)}
        onCropped={(dataUri) => {
          setPicked(null);
          // A 256px WebP lands two orders of magnitude inside the cap, so this
          // only fires on something pathological - and it is worth saying here
          // rather than letting the server answer for it.
          if (dataUri.length > MAX_AVATAR_STRING_LEN) {
            toast.error("That image is too large");
            return;
          }
          commit(dataUri);
        }}
      />
      <input
        ref={inputRef}
        type="file"
        accept={AVATAR_ACCEPT_ATTR}
        className="hidden"
        onChange={(e) => {
          pick(e.target.files?.[0]);
          // Reset so re-picking the same file fires change again.
          e.target.value = "";
        }}
      />
    </div>
  );
}
