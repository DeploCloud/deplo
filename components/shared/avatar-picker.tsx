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
  type AvatarStyle,
  DEFAULT_INITIALS_PRESET,
  DEFAULT_PIXELBOT_PRESET,
  facePath,
  GRAVATAR_VALUE,
  INITIALS_PRESETS,
  INITIALS_VALUE,
  MAX_AVATAR_STRING_LEN,
  PIXELBOT_PRESETS,
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
  /** Their initials, which ARE the seed of an `initials` picture: DiceBear reads
   *  the letters out of it ("Ada Lovelace" and "AL" both draw AL). */
  letters: string;
  /** The monogram itself, so the plain option shows what it would look like
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
  const seed = sources?.seed;
  const letters = sources?.letters;
  const look =
    sources?.choice.kind === "generated" && sources.choice.style === "pixelbot"
      ? sources.choice.preset
      : DEFAULT_PIXELBOT_PRESET;
  React.useEffect(() => {
    if (!seed || !letters) return;
    const rolled = rollPreviewSeeds(seed);
    setPreviews(rolled);
    // Fetched now, not on the click: the dialog would otherwise open onto empty
    // circles and fill them in one by one.
    for (const url of [
      ...PIXELBOT_PRESETS.map(({ id }, i) =>
        facePath("pixelbot", id, rolled[i]!),
      ),
      ...pixelbotRowSeeds(seed).map((s) => facePath("pixelbot", look, s)),
      ...INITIALS_PRESETS.map(({ id }) => facePath("initials", id, letters)),
    ]) {
      const img = new window.Image();
      img.src = url;
    }
  }, [seed, letters, look]);
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
          previews={previews}
          dragging={dragging}
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

/** One picture in the row. The SVG comes from `/api/avatar`, so the renderer
 *  never reaches the browser. */
function FaceTile({
  style,
  preset,
  label,
  seed,
  selected,
  disabled,
  onClick,
}: {
  style: AvatarStyle;
  preset: string;
  label: string;
  seed: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <TileButton
      label={label}
      selected={selected}
      disabled={disabled}
      onClick={onClick}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={facePath(style, preset, seed)}
        alt=""
        draggable={false}
        // The picture is opaque, so this only shows while it is still coming.
        className="block w-full rounded-full bg-muted"
      />
    </TileButton>
  );
}

/** The round, ringed control every tile in the two rows is. */
function TileButton({
  label,
  selected,
  disabled,
  onClick,
  className,
  children,
}: {
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
  children: React.ReactNode;
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
        className,
      )}
    >
      {children}
    </button>
  );
}

/** One face per look, drawn when the picker mounts - never during a render,
 *  which is why it takes an effect and not a `useMemo`. */
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
  preset: string;
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
        src={facePath("pixelbot", preset, seed)}
        alt=""
        draggable={false}
        className="block w-full rounded-full bg-muted"
      />
    </button>
  );
}

/** Where a picture comes from when it is not a generated one. */
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
  dragging,
  onPick,
  onUpload,
  onDragOver,
  onDragLeave,
  onDrop,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sources: AvatarSources;
  busy: boolean;
  /** One preview face per look, rolled by the caller as it mounts. */
  previews: string[] | null;
  dragging: boolean;
  onPick: (value: string) => void;
  onUpload: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { choice, seed, letters } = sources;
  const worn = choice.kind === "generated" ? choice : null;
  const rowSeeds = pixelbotRowSeeds(seed);
  const [style, setStyle] = React.useState<AvatarStyle>(
    worn?.style ?? "pixelbot",
  );
  const [look, setLook] = React.useState(
    worn?.style === "pixelbot" ? worn.preset : DEFAULT_PIXELBOT_PRESET,
  );
  // The chips show the palette, not a particular face, so the caller rolls one
  // face per look on the way in. Before the first roll, a plain rotation.
  const chipSeeds =
    previews ?? PIXELBOT_PRESETS.map((_, i) => rowSeeds[i % rowSeeds.length]!);
  const lookLabel = PIXELBOT_PRESETS.find((p) => p.id === look)!.label;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("sm:max-w-lg", dragging && "ring-2 ring-ring")}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <DialogHeader>
          <DialogTitle>Profile picture</DialogTitle>
          <DialogDescription>
            Pick a look, then a face - or upload your own.
          </DialogDescription>
        </DialogHeader>
        {style === "pixelbot" ? (
          <div className="grid grid-cols-6 gap-2">
            {rowSeeds.map((rowSeed) => (
              <FaceTile
                key={rowSeed}
                style="pixelbot"
                preset={look}
                label={`${lookLabel} face`}
                seed={rowSeed}
                disabled={busy}
                selected={
                  worn?.style === "pixelbot" &&
                  worn.preset === look &&
                  worn.seed === rowSeed
                }
                onClick={() => onPick(`pixelbot:${look}:${rowSeed}`)}
              />
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-7 gap-2">
            <TileButton
              label="Plain initials"
              selected={choice.kind === "initials"}
              disabled={busy}
              className="grid place-items-center"
              onClick={() => onPick(INITIALS_VALUE)}
            >
              {sources.monogram ?? (
                <span className="grid aspect-square w-full place-items-center rounded-full bg-secondary text-xs font-medium text-secondary-foreground">
                  {letters}
                </span>
              )}
            </TileButton>
            {INITIALS_PRESETS.map(({ id, label }) => (
              <FaceTile
                key={id}
                style="initials"
                preset={id}
                label={label}
                seed={letters}
                disabled={busy}
                selected={worn?.style === "initials" && worn.preset === id}
                onClick={() => onPick(`initials:${id}:${letters}`)}
              />
            ))}
          </div>
        )}
        <div className="grid grid-cols-9 gap-1.5">
          {PIXELBOT_PRESETS.map(({ id, label }, i) => (
            <PresetChip
              key={id}
              preset={id}
              label={label}
              seed={chipSeeds[i]!}
              disabled={busy}
              selected={style === "pixelbot" && id === look}
              onClick={() => {
                setStyle("pixelbot");
                setLook(id);
              }}
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
            selected={
              style === "initials" ||
              choice.kind === "initials" ||
              worn?.style === "initials"
            }
            disabled={busy}
            onClick={() => {
              setStyle("initials");
              if (worn?.style !== "initials") setLook(DEFAULT_INITIALS_PRESET);
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
