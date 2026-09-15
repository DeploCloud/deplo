"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { AtSign, Camera, Upload } from "lucide-react";

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
  AVATAR_VARIANTS,
  type AvatarChoice,
  DEFAULT_PACK,
  facePath,
  GRAVATAR_VALUE,
  MAX_AVATAR_STRING_LEN,
  packRow,
  packsFor,
  previewSeed,
} from "@/lib/apps/avatar-shared";
import { ImageCropDialog } from "@/components/shared/image-crop-dialog";
import { TeamPlaceholder } from "@/components/shared/user-avatar";

export type AvatarSources = {
  choice: AvatarChoice;
  letters: string;
  gravatar?: string | null;
  team?: boolean;
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
  preview?: React.ReactNode;
  hasImage?: boolean;
  onSave: (image: string | null) => Promise<{ ok: boolean; error?: string }>;
  disabled?: boolean;
  quiet?: boolean;
  label?: string;
  children?: React.ReactNode;
  sources?: AvatarSources;
  controlled?: { open: boolean; onOpenChange: (open: boolean) => void };
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
  const letters = sources?.letters;
  const team = sources?.team;
  React.useEffect(() => {
    const seed = letters === undefined ? "" : previewSeed(letters, team);
    if (!preload || !seed) return;
    for (const pack of packsFor(team))
      for (const tile of packRow(pack, seed)) {
        const img = new window.Image();
        img.src = facePath(tile.style, tile.preset, tile.seed);
      }
  }, [preload, letters, team]);
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
          e.target.value = "";
        }}
      />
    </>
  );

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

function FaceTile({
  src,
  label,
  selected,
  disabled,
  onClick,
  small = false,
}: {
  src: string | null;
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
      {src ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          src={src}
          alt=""
          draggable={false}
          className="block w-full rounded-full bg-muted"
        />
      ) : (
        <TeamPlaceholder className="w-full" />
      )}
    </button>
  );
}

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
  dragging: boolean;
  onPick: (value: string | null) => void;
  onUpload: () => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}) {
  const { choice, letters, gravatar } = sources;
  const seed = previewSeed(letters, sources.team);
  const worn = choice.kind === "generated" ? choice : null;
  const packs = packsFor(sources.team);
  const [pack, setPack] = React.useState(
    () => packs.find((p) => p.style === worn?.style) ?? DEFAULT_PACK,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className={cn("sm:max-w-lg", dragging && "ring-2 ring-ring")}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <DialogHeader>
          <DialogTitle>
            {sources.team ? "Team picture" : "Profile picture"}
          </DialogTitle>
          <DialogDescription>
            {sources.team
              ? "Stands before the team's name everywhere it appears. Pick one, or upload your own."
              : "Stands next to your name everywhere in Deplo. Pick one, or upload your own."}
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-4 gap-2">
          {packRow(pack, seed).map((tile) => (
            <FaceTile
              key={`${tile.preset}:${tile.seed}`}
              src={
                tile.seed ? facePath(tile.style, tile.preset, tile.seed) : null
              }
              label={tile.label}
              disabled={busy || !tile.seed}
              selected={
                tile.derived
                  ? choice.kind === "initials"
                  : worn?.style === tile.style &&
                    worn.preset === tile.preset &&
                    worn.seed === tile.seed
              }
              onClick={() =>
                onPick(
                  tile.derived
                    ? null
                    : `${tile.style}:${tile.preset}:${tile.seed}`,
                )
              }
            />
          ))}
        </div>
        {packs.length > 1 ? (
          <div className="flex justify-center gap-2">
            {packs.map((p) => (
              <FaceTile
                key={p.style}
                small
                src={facePath(
                  p.style,
                  p.preset,
                  p.style === "initials" ? seed : AVATAR_VARIANTS[0],
                )}
                label={p.label}
                disabled={busy}
                selected={p.style === pack.style}
                onClick={() => setPack(p)}
              />
            ))}
          </div>
        ) : null}
        <div className="grid gap-2">
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
            quiet
            visual={
              choice.kind === "uploaded" ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={choice.src}
                  alt=""
                  draggable={false}
                  className="size-full object-cover"
                />
              ) : (
                <Upload className="size-3.5" />
              )
            }
            label="Upload a picture"
            selected={choice.kind === "uploaded"}
            disabled={busy}
            onClick={onUpload}
          />
        </div>
        <p className="text-center text-[11px] leading-relaxed text-muted-foreground">
          Pictures by DiceBear.{" "}
          {packs.some((p) => p.style === "glyphs") ? (
            <>
              {AVATAR_ATTRIBUTION.style} is a remix of{" "}
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
            </>
          ) : null}
        </p>
      </DialogContent>
    </Dialog>
  );
}
