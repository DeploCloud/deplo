"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Camera } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  AVATAR_ACCEPT_ATTR,
  AVATAR_IMAGE_TYPES,
  avatarChoiceFromUrl,
  GRAVATAR_VALUE,
  INITIALS_VALUE,
  MAX_AVATAR_STRING_LEN,
  PIXELBOT_PREFIX,
  PIXELBOT_PRESETS,
  pixelbotPath,
} from "@/lib/apps/avatar-shared";
import { ImageCropDialog } from "@/components/shared/image-crop-dialog";

/**
 * Change a profile picture by clicking the picture. Every source commits on the
 * spot - there is no Save button after it, because the change is one value with
 * no other state to reconcile.
 */

/** A person picks a source; a team has only its own file (`sources` omitted),
 *  and clicking the picture goes straight to the file dialog. */
export type AvatarSources = {
  /** What is in use now, as the resolved URL the caller already renders. */
  avatarUrl: string | null;
  /** Seeds the face offered first - their user id. Absent during onboarding,
   *  where the account has no id yet. */
  defaultSeed?: string | null;
  /** Whether the instance allows Gravatar at all. */
  gravatar?: boolean;
};

export function AvatarPicker({
  preview,
  hasImage,
  onSave,
  disabled,
  quiet = false,
  label = "Change picture",
  children,
  sources,
}: {
  /** The avatar to render - the caller's own `<UserAvatar>` / `<TeamAvatar>`. */
  preview: React.ReactNode;
  /** Whether there is an uploaded picture to remove. Gravatar is not removable
   *  here: it is not stored, and turning it off is an instance-wide decision. */
  hasImage: boolean;
  onSave: (image: string | null) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  /** Held, not saved: skip the toast and the refresh - onboarding picks a
   *  picture for an account that does not exist yet. */
  quiet?: boolean;
  label?: string;
  /** What sits beside the picture. Remove lands under the picture itself. */
  children?: React.ReactNode;
  sources?: AvatarSources;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();
  const [dragging, setDragging] = React.useState(false);
  const [picked, setPicked] = React.useState<File | null>(null);
  const [choosing, setChoosing] = React.useState(false);
  const busy = pending || disabled;

  function commit(image: string | null) {
    startTransition(async () => {
      const res = await onSave(image);
      if (res.ok) {
        if (quiet) return;
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
    <div className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5">
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          sources ? setChoosing(true) : inputRef.current?.click()
        }
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
          "group relative col-start-1 row-start-1 cursor-pointer rounded-full transition outline-none",
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
        <span className="absolute right-0 bottom-0 flex size-7 items-center justify-center rounded-full border border-border bg-secondary text-secondary-foreground">
          <Camera className="size-3.5" />
        </span>
      </button>
      {hasImage && !sources && (
        <Button
          variant="ghost"
          size="sm"
          className="col-start-1 row-start-2 h-7 justify-self-center px-2 text-xs text-muted-foreground hover:text-foreground"
          disabled={busy}
          onClick={() => commit(null)}
        >
          Remove
        </Button>
      )}
      {children ? (
        <div className="col-start-2 row-start-1 min-w-0">{children}</div>
      ) : null}
      {sources ? (
        <AvatarSourceDialog
          open={choosing}
          onOpenChange={setChoosing}
          sources={sources}
          busy={Boolean(busy)}
          onPick={(value) => {
            setChoosing(false);
            commit(value);
          }}
          onUpload={() => inputRef.current?.click()}
        />
      ) : null}
      <ImageCropDialog
        file={picked}
        variant="avatar"
        onClose={() => setPicked(null)}
        onCropped={(dataUri) => {
          setPicked(null);
          setChoosing(false);
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

/** One face in the grid. The SVG comes from `/api/avatar`, so the renderer never
 *  reaches the browser. */
function FaceTile({
  seed,
  selected,
  disabled,
  onClick,
}: {
  seed: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "rounded-full transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "ring-2 ring-primary" : "hover:opacity-80",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <img src={pixelbotPath(seed)} alt="" className="size-12 rounded-full" />
    </button>
  );
}

function AvatarSourceDialog({
  open,
  onOpenChange,
  sources,
  busy,
  onPick,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: AvatarSources;
  busy: boolean;
  onPick: (value: string) => void;
  onUpload: () => void;
}) {
  const choice = avatarChoiceFromUrl(sources.avatarUrl);
  const seeds = [
    ...(sources.defaultSeed ? [sources.defaultSeed] : []),
    ...PIXELBOT_PRESETS,
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Profile picture</DialogTitle>
          <DialogDescription>
            Pick a face, upload your own, or wear your initials.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap justify-center gap-2">
          {seeds.map((seed) => (
            <FaceTile
              key={seed}
              seed={seed}
              disabled={busy}
              selected={choice.kind === "generated" && choice.seed === seed}
              onClick={() => onPick(`${PIXELBOT_PREFIX}${seed}`)}
            />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant={choice.kind === "uploaded" ? "secondary" : "outline"}
            disabled={busy}
            onClick={onUpload}
          >
            Upload a picture
          </Button>
          {sources.gravatar ? (
            <Button
              variant={choice.kind === "gravatar" ? "secondary" : "outline"}
              disabled={busy}
              onClick={() => onPick(GRAVATAR_VALUE)}
            >
              Use Gravatar
            </Button>
          ) : null}
          <Button
            variant={choice.kind === "initials" ? "secondary" : "outline"}
            disabled={busy}
            onClick={() => onPick(INITIALS_VALUE)}
          >
            Use my initials
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
