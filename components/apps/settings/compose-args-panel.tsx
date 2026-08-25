"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Save, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InfoTip } from "@/components/ui/info-tip";
import {
  composeUpCommandPreview,
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "@/lib/deploy/compose-args";
import { gqlAction } from "@/lib/graphql-client";

/**
 * Extra flags for the `docker compose up` that brings this app up. Validated as
 * you type, with the offending token named - the field is advanced, but "invalid
 * input" would still leave you guessing which of six flags Deplo objected to.
 */
export function ComposeArgsPanel({
  appId,
  slug,
  value: initialValue,
  usesEnvFile,
}: {
  appId: string;
  slug: string;
  /** The stored flags, or null for the untouched command. */
  value: string | null;
  /** A compose stack interpolates `${VAR}`, so its bring-up carries an env-file -
   * shown in the preview so it matches what the host actually runs. */
  usesEnvFile: boolean;
}) {
  const router = useRouter();
  const [text, setText] = React.useState(initialValue ?? "");
  const [saved, setSaved] = React.useState(initialValue ?? "");
  const [pending, startTransition] = React.useTransition();

  const error = React.useMemo(() => validateComposeUpArgs(text), [text]);
  const extra = React.useMemo(() => parseComposeUpArgs(text), [text]);
  const dirty = text.trim() !== saved.trim();
  // Deplo's half of the command, so the preview can print it muted next to the
  // operator's - same builder the deploy path uses, so it can't drift.
  const base = composeUpCommandPreview({ slug, usesEnvFile, extra: [] });

  function save(e: React.FormEvent) {
    e.preventDefault();
    if (error || !dirty) return;
    const committed = text.trim();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $value: String) { setAppComposeUpArgs(id: $id, value: $value) { id } }`,
        { id: appId, value: committed || null },
      );
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      setSaved(committed);
      setText(committed);
      toast.success(
        committed ? "Compose flags saved" : "Back to the default command",
      );
      router.refresh();
    });
  }

  return (
    <form
      onSubmit={save}
      className="space-y-3 rounded-lg border border-border p-3"
    >
      <div className="space-y-0.5">
        <p className="flex items-center gap-1.5 text-sm font-medium">
          Extra compose flags
          <InfoTip
            content={
              <>
                Deplo builds the command that starts your app. These flags are
                added to the end of it - the project, the stack file and the
                env-file stay Deplo&apos;s, so a flag here can never point the
                command at another app. Applied on every deploy and every
                routing change.
              </>
            }
            docs="compose.flags"
          />
        </p>
        <p className="text-xs text-muted-foreground">
          Add flags to the command that brings this app up, like{" "}
          <code className="font-mono text-[0.7rem]">--pull always</code>. Leave
          empty for the default.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="--pull always"
          spellCheck={false}
          autoComplete="off"
          aria-label="Extra compose flags"
          aria-invalid={error != null}
          className="font-mono text-xs"
        />
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={pending || !dirty || error != null}
        >
          <Save className="size-4" />
          Save
        </Button>
      </div>

      {/* The command as the owning server will run it: Deplo's part muted, yours
          in full contrast. Scrolls on its own so a long flag never widens the card. */}
      <div className="overflow-x-auto rounded-md border border-border bg-muted/30 px-3 py-2">
        <code className="flex items-baseline gap-1.5 font-mono text-[0.7rem] leading-relaxed whitespace-pre">
          <Terminal
            aria-hidden
            className="size-3 shrink-0 translate-y-px text-muted-foreground/70"
          />
          <span className="text-muted-foreground/70">{base}</span>
          {extra.length > 0 && !error && (
            <span className="font-medium text-foreground">
              {extra.join(" ")}
            </span>
          )}
        </code>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
