"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Flag, Save, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FeatureRow } from "@/components/apps/settings/settings-shared";
import {
  composeUpCommandPreview,
  parseComposeUpArgs,
  validateComposeUpArgs,
} from "@/lib/deploy/compose-args";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { gqlAction } from "@/lib/graphql-client";

export function ComposeArgsPanel({
  appId,
  slug,
  value: initialValue,
  usesEnvFile,
}: {
  appId: string;
  slug: string;
  value: string | null;
  usesEnvFile: boolean;
}) {
  const router = useRouter();
  const [text, setText] = React.useState(initialValue ?? "");
  const [saved, setSaved] = React.useState(initialValue ?? "");
  const [pending, startTransition] = React.useTransition();

  const error = React.useMemo(() => validateComposeUpArgs(text), [text]);
  const extra = React.useMemo(() => parseComposeUpArgs(text), [text]);
  const dirty = text.trim() !== saved.trim();
  const yours = error ? "" : extra.join(" ");
  const full = composeUpCommandPreview({
    slug,
    usesEnvFile,
    extra: error ? [] : extra,
  });
  const base = yours ? full.slice(0, -yours.length) : full;

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
    <form onSubmit={save}>
      <FeatureRow
        icon={Flag}
        title="Extra compose flags"
        info="Added to the end of the command Deplo runs. The project and its files stay Deplo's, so a flag can never point it at another app."
        docs="compose.flags"
        description={
          <>
            Add flags to the command that brings this app up, like{" "}
            <code className="font-mono text-[0.7rem]">--wait</code>. Leave empty
            for the default.
          </>
        }
      >
        <div className="mt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Input
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="--wait"
              spellCheck={false}
              autoComplete="off"
              aria-label="Extra compose flags"
              aria-invalid={error != null}
              className="font-mono text-xs"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={pending || !dirty || error != null}
            >
              <Save className="size-4" />
              Save
            </Button>
          </div>

          <div className="overflow-x-auto rounded-md border border-border bg-surface px-3 py-2">
            <code className="flex items-baseline gap-1.5 font-mono text-[0.7rem] leading-relaxed whitespace-pre">
              <Terminal
                aria-hidden
                className="size-3 shrink-0 translate-y-px text-muted-foreground/70"
              />
              <span className="text-muted-foreground/70">{base}</span>
              {yours && (
                <span className="font-medium text-foreground">{yours}</span>
              )}
            </code>
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      </FeatureRow>

      <UnsavedChangesGuard when={dirty} />
    </form>
  );
}
