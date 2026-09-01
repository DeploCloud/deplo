"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AtSign, Camera, Upload, UserRound } from "lucide-react";

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
  type AvatarChoice,
  GRAVATAR_VALUE,
  INITIALS_VALUE,
  MAX_AVATAR_STRING_LEN,
  DEFAULT_PIXELBOT_PRESET,
  PIXELBOT_PREFIX,
  PIXELBOT_PRESETS,
  type PixelbotPreset,
  pixelbotPath,
  pixelbotRowSeeds,
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
  /** What is in use now - `avatarChoiceFromUrl` where the picture is saved,
   *  `avatarChoiceFromValue` where a form still holds the raw value. */
  choice: AvatarChoice;
  /** Seeds every generated face: their user id, or the handle they are typing
   *  during onboarding. What they preview is what gets saved. */
  seed: string;
  /** The monogram itself, so "Use my initials" shows what it would look like
   *  rather than describing it. The caller's own `<UserAvatar>` with no picture. */
  monogram?: React.ReactNode;
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
  const [previews, setPreviews] = React.useState<string[] | null>(null);
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
        onClick={() => {
          if (!sources) {
            inputRef.current?.click();
            return;
          }
          setPreviews(rollPreviewSeeds(sources.seed));
          setChoosing(true);
        }}
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
          previews={previews}
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

/** One look in the grid: the SAME face, in one of the style's presets. The SVG
 *  comes from `/api/avatar`, so the renderer never reaches the browser. */
function FaceTile({
  preset,
  label,
  seed,
  selected,
  disabled,
  onClick,
}: {
  preset: PixelbotPreset;
  label: string;
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
      aria-label={label}
      title={label}
      className={cn(
        "w-full rounded-full transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "ring-2 ring-primary ring-offset-2 ring-offset-background"
          : "hover:opacity-80",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={pixelbotPath(preset, seed)}
        alt=""
        className="block w-full rounded-full"
      />
    </button>
  );
}

/** One face per look, drawn when the dialog is opened - never during a render,
 *  which is why it takes the click and not a `useMemo`. */
function rollPreviewSeeds(seed: string): string[] {
  const seeds = pixelbotRowSeeds(seed);
  return PIXELBOT_PRESETS.map(
    () => seeds[Math.floor(Math.random() * seeds.length)]!,
  );
}

/** One look in the selector: a single face previews the palette, so opening the
 *  dialog costs nine renders and not nine times six. */
function PresetChip({
  preset,
  label,
  seed,
  selected,
  disabled,
  onClick,
}: {
  preset: PixelbotPreset;
  label: string;
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
      aria-label={label}
      title={label}
      className={cn(
        "w-full rounded-full transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "ring-2 ring-primary ring-offset-1 ring-offset-background"
          : "opacity-70 hover:opacity-100",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={pixelbotPath(preset, seed)}
        alt=""
        className="block w-full rounded-full"
      />
    </button>
  );
}

/** Where a picture comes from when it is not a generated face. */
function SourceCard({
  visual,
  label,
  selected,
  disabled,
  onClick,
}: {
  visual: React.ReactNode;
  label: string;
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
        "flex items-center gap-3 rounded-xl border p-3 text-left text-sm font-medium transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary bg-accent"
          : "border-border bg-card hover:bg-accent",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-full bg-secondary text-secondary-foreground">
        {visual}
      </span>
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

function AvatarSourceDialog({
  open,
  onOpenChange,
  sources,
  busy,
  previews,
  onPick,
  onUpload,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: AvatarSources;
  busy: boolean;
  /** One preview face per look, rolled by the caller on open. */
  previews: string[] | null;
  onPick: (value: string) => void;
  onUpload: () => void;
}) {
  const { choice } = sources;
  const rowSeeds = pixelbotRowSeeds(sources.seed);
  const [look, setLook] = React.useState<PixelbotPreset>(
    choice.kind === "generated" ? choice.preset : DEFAULT_PIXELBOT_PRESET,
  );
  // The chips show the palette, not a particular face, so the caller rolls one
  // face per look on the way in. Before the first open, a plain rotation.
  const chipSeeds =
    previews ?? PIXELBOT_PRESETS.map((_, i) => rowSeeds[i % rowSeeds.length]!);
  const lookLabel = PIXELBOT_PRESETS.find((p) => p.id === look)!.label;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Profile picture</DialogTitle>
          <DialogDescription>
            Pick a look, then a face - or upload your own.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-6 gap-2">
          {rowSeeds.map((rowSeed) => (
            <FaceTile
              key={rowSeed}
              preset={look}
              label={`${lookLabel} face`}
              seed={rowSeed}
              disabled={busy}
              selected={
                choice.kind === "generated" &&
                choice.preset === look &&
                choice.seed === rowSeed
              }
              onClick={() => onPick(`${PIXELBOT_PREFIX}${look}:${rowSeed}`)}
            />
          ))}
        </div>
        <div className="grid grid-cols-9 gap-1.5">
          {PIXELBOT_PRESETS.map(({ id, label }, i) => (
            <PresetChip
              key={id}
              preset={id}
              label={label}
              seed={chipSeeds[i]!}
              disabled={busy}
              selected={id === look}
              onClick={() => setLook(id)}
            />
          ))}
        </div>
        <div
          className={cn(
            "grid gap-2",
            sources.gravatar ? "sm:grid-cols-3" : "sm:grid-cols-2",
          )}
        >
          <SourceCard
            visual={<Upload className="size-4" />}
            label="Upload a picture"
            selected={choice.kind === "uploaded"}
            disabled={busy}
            onClick={onUpload}
          />
          {sources.gravatar ? (
            <SourceCard
              visual={<AtSign className="size-4" />}
              label="Use Gravatar"
              selected={choice.kind === "gravatar"}
              disabled={busy}
              onClick={() => onPick(GRAVATAR_VALUE)}
            />
          ) : null}
          <SourceCard
            visual={sources.monogram ?? <UserRound className="size-4" />}
            label="Use my initials"
            selected={choice.kind === "initials"}
            disabled={busy}
            onClick={() => onPick(INITIALS_VALUE)}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
