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
  AVATAR_ATTRIBUTION,
  AVATAR_IMAGE_TYPES,
  AVATAR_PACKS,
  type AvatarChoice,
  DEFAULT_INITIALS_PRESET,
  DEFAULT_PACK,
  facePath,
  GRAVATAR_VALUE,
  INITIALS_PRESETS,
  MAX_AVATAR_STRING_LEN,
  rowSeeds,
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
  /** Their Gravatar address when the instance allows it, so the card previews
   *  the real thing. Absent = the source is not offered. */
  gravatar?: string | null;
};

export function AvatarPicker({
  preview,
  hasImage = false,
  onSave,
  disabled,
  quiet = false,
  label = "Change picture",
  children,
  sources,
  controlled,
  preload = true,
}: {
  /** The avatar to render - the caller's own `<UserAvatar>` / `<TeamAvatar>`.
   *  Unused, and unnecessary, when `controlled` supplies the trigger. */
  preview?: React.ReactNode;
  /** Whether there is an uploaded picture to remove. Gravatar is not removable
   *  here: it is not stored, and turning it off is an instance-wide decision. */
  hasImage?: boolean;
  onSave: (image: string | null) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  /** Held, not saved: skip the toast and the refresh - onboarding picks a
   *  picture for an account that does not exist yet. */
  quiet?: boolean;
  label?: string;
  /** What sits beside the picture. Remove lands under the picture itself. */
  children?: React.ReactNode;
  sources?: AvatarSources;
  /** Driven from outside instead of by the built-in trigger: the header menu
   *  opens it from a dropdown, where a dialog nested in the menu would unmount
   *  with it. Renders the dialogs and nothing else. */
  controlled?: { open: boolean; onOpenChange: (open: boolean) => void };
  /** Whether to fetch the pictures now. The header mounts on every page, so it
   *  waits until the menu is open - one click before they can be needed. */
  preload?: boolean;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();
  const [dragging, setDragging] = React.useState(false);
  const [picked, setPicked] = React.useState<File | null>(null);
  const [ownChoosing, setOwnChoosing] = React.useState(false);
  const choosing = controlled ? controlled.open : ownChoosing;
  const setChoosing = controlled ? controlled.onOpenChange : setOwnChoosing;
  const [previews, setPreviews] = React.useState<string[] | null>(null);
  const seed = sources?.seed;
  const letters = sources?.letters;
  React.useEffect(() => {
    if (!preload || !seed || !letters) return;
    const rolled = rollPreviewSeeds(seed);
    setPreviews(rolled);
    // Fetched now, not on the click: the dialog would otherwise open onto empty
    // circles and fill them in one by one.
    for (const url of [
      ...AVATAR_PACKS.flatMap((pack, i) => [
        facePath(pack.style, pack.preset, rolled[i]!),
        ...rowSeeds(seed).map((s) => facePath(pack.style, pack.preset, s)),
      ]),
      ...INITIALS_PRESETS.map(({ id }) => facePath("initials", id, letters)),
    ]) {
      const img = new window.Image();
      img.src = url;
    }
  }, [preload, seed, letters]);
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

  const editor = (
    <>
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
    </>
  );

  // Nothing but the dialogs: the caller drew the trigger and owns the state.
  if (controlled) return editor;

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
      {editor}
    </div>
  );
}

/** One picture in a row: the SVG comes from `/api/avatar`, so the renderer never
 *  reaches the browser. */
function FaceTile({
  src,
  label,
  selected,
  disabled,
  onClick,
  small = false,
}: {
  src: string;
  label: string;
  selected: boolean;
  disabled?: boolean;
  onClick: () => void;
  small?: boolean;
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
        // The selector under the row is a selector, not a second row of choices.
        small ? "w-10" : "w-full",
        "rounded-full transition outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? cn(
              "ring-2 ring-primary ring-offset-background",
              small ? "ring-offset-1" : "ring-offset-2",
            )
          : small
            ? "opacity-70 hover:opacity-100"
            : "hover:opacity-80",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt=""
        draggable={false}
        // The picture is opaque, so this only shows while it is still coming.
        className="block w-full rounded-full bg-muted"
      />
    </button>
  );
}

/** One picture per pack, drawn when the picker mounts - never during a render,
 *  which is why it takes an effect and not a `useMemo`. */
function rollPreviewSeeds(seed: string): string[] {
  const seeds = rowSeeds(seed);
  return AVATAR_PACKS.map(
    () => seeds[Math.floor(Math.random() * seeds.length)]!,
  );
}

/** Where a picture comes from when it is not one of the packs. */
function SourceCard({
  visual,
  label,
  selected,
  disabled,
  quiet = false,
  className,
  onClick,
}: {
  visual: React.ReactNode;
  label: string;
  selected: boolean;
  disabled?: boolean;
  /** The lesser of the sources: same card, less weight. */
  quiet?: boolean;
  className?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex items-center gap-3 rounded-xl border text-left font-medium transition-colors outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring",
        quiet ? "p-2 text-xs text-muted-foreground" : "p-3 text-sm",
        selected
          ? "border-primary bg-accent"
          : "border-border bg-card hover:bg-accent",
        disabled && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <span
        className={cn(
          "relative grid shrink-0 place-items-center overflow-hidden rounded-full bg-secondary text-secondary-foreground",
          quiet ? "size-7" : "size-9",
        )}
      >
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
  /** One preview picture per pack, rolled by the caller as it mounts. */
  previews: string[] | null;
  dragging: boolean;
  onPick: (value: string) => void;
  onUpload: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { choice, seed, letters, gravatar } = sources;
  const worn = choice.kind === "generated" ? choice : null;
  const seeds = rowSeeds(seed);
  const [pack, setPack] = React.useState(() =>
    worn && worn.style !== "initials"
      ? (AVATAR_PACKS.find((p) => p.style === worn.style) ?? DEFAULT_PACK)
      : DEFAULT_PACK,
  );
  const [onInitials, setOnInitials] = React.useState(
    worn?.style === "initials",
  );
  // The chips show the pack, not a particular picture, so the caller rolls one
  // per pack on the way in. Before the first roll, a plain rotation.
  const chipSeeds =
    previews ?? AVATAR_PACKS.map((_, i) => seeds[i % seeds.length]!);

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
            {onInitials
              ? "Two letters. Yours, with the volume up."
              : "Pick a pack, then a picture - or upload your own."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-4 gap-2">
          {onInitials
            ? INITIALS_PRESETS.map(({ id, label }) => (
                <FaceTile
                  key={id}
                  src={facePath("initials", id, letters)}
                  label={label}
                  disabled={busy}
                  selected={worn?.style === "initials" && worn.preset === id}
                  onClick={() => onPick(`initials:${id}:${letters}`)}
                />
              ))
            : seeds.map((rowSeed) => (
                <FaceTile
                  key={rowSeed}
                  src={facePath(pack.style, pack.preset, rowSeed)}
                  label={`${pack.label}, ${rowSeed === seed ? "yours" : rowSeed}`}
                  disabled={busy}
                  selected={
                    worn?.style === pack.style &&
                    worn.preset === pack.preset &&
                    worn.seed === rowSeed
                  }
                  onClick={() =>
                    onPick(`${pack.style}:${pack.preset}:${rowSeed}`)
                  }
                />
              ))}
        </div>
        <div className="flex justify-center gap-2">
          {AVATAR_PACKS.map((p, i) => (
            <FaceTile
              key={p.style}
              small
              src={facePath(p.style, p.preset, chipSeeds[i]!)}
              label={p.label}
              disabled={busy}
              selected={!onInitials && p.style === pack.style}
              onClick={() => {
                setOnInitials(false);
                setPack(p);
              }}
            />
          ))}
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          {gravatar ? (
            <SourceCard
              visual={
                <>
                  <AtSign className="size-4" />
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={gravatar}
                    alt=""
                    draggable={false}
                    // Absent from gravatar.com, the icon underneath stands.
                    className="absolute inset-0 size-full object-cover"
                  />
                </>
              }
              label="Use Gravatar"
              selected={choice.kind === "gravatar"}
              disabled={busy}
              onClick={() => onPick(GRAVATAR_VALUE)}
            />
          ) : null}
          <SourceCard
            visual={
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={facePath("initials", DEFAULT_INITIALS_PRESET, letters)}
                alt=""
                draggable={false}
                className="size-full"
              />
            }
            label="Use my initials"
            // What they WEAR, never what the row above happens to be showing:
            // browsing to the letters is not choosing them.
            selected={worn?.style === "initials"}
            disabled={busy}
            className={gravatar ? undefined : "sm:col-span-2"}
            onClick={() => setOnInitials(true)}
          />
          <SourceCard
            quiet
            visual={<Upload className="size-3.5" />}
            label="Upload a picture"
            selected={choice.kind === "uploaded"}
            disabled={busy}
            className="sm:col-span-2"
            onClick={onUpload}
          />
        </div>
        <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
          Pictures by DiceBear. {AVATAR_ATTRIBUTION.style} is a remix of{" "}
          <a
            href={AVATAR_ATTRIBUTION.sourceUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {AVATAR_ATTRIBUTION.source}
          </a>{" "}
          by {AVATAR_ATTRIBUTION.creator},{" "}
          <a
            href={AVATAR_ATTRIBUTION.licenseUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {AVATAR_ATTRIBUTION.license}
          </a>
          .
        </p>
      </DialogContent>
    </Dialog>
  );
}
