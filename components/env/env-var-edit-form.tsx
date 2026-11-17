"use client";

import * as React from "react";
import { useRouter } from "@/lib/nav";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FieldLabel } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { cleanNote, KEY_RE } from "@/lib/env-file";
import { SecretRow } from "@/components/env/secret-row";
import { NoteField } from "@/components/env/note-field";
import type { EnvVarDTO } from "@/lib/types/env";

export function EnvVarEditForm({
  open,
  onOpenChange,
  appId,
  editing,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  appId: string;
  editing: EnvVarDTO;
}) {
  const [key, setKey] = React.useState(editing.key);
  const [value, setValue] = React.useState(editing.value);
  const [secret, setSecret] = React.useState(editing.type === "secret");
  const [note, setNote] = React.useState(editing.note ?? "");
  const [pending, startTransition] = React.useTransition();
  const router = useRouter();

  // A secret keeps its name and value: only its note can change.
  const noteOnly = editing.type === "secret" && !editing.connected;
  const trimmedKey = key.trim();
  const keyValid = KEY_RE.test(trimmedKey);
  const renamed = trimmedKey !== editing.key;
  const valueChanged =
    !noteOnly &&
    !editing.connected &&
    (value !== editing.value || secret !== (editing.type === "secret"));
  const noteChanged = cleanNote(note) !== (editing.note ?? null);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    onOpenChange(false);
    startTransition(async () => {
      // The rename goes first: it is keyed by id, so it cannot clash with the upsert below.
      if (renamed) {
        const r = await gqlAction<{ renameEnv: { id: string } }>(
          `mutation($id: String!, $newKey: String!) {
            renameEnv(id: $id, newKey: $newKey) { id }
          }`,
          { id: editing.id, newKey: trimmedKey },
        );
        if (!r.ok) {
          onOpenChange(true);
          toast.error(r.error);
          return;
        }
      }
      // A note on its own goes through setEnvNote, which leaves "Updated by" and pending changes alone.
      if (noteChanged && !valueChanged) {
        const n = await gqlAction<{ setEnvNote: { id: string } }>(
          `mutation($id: String!, $note: String) {
            setEnvNote(id: $id, note: $note) { id }
          }`,
          { id: editing.id, note: cleanNote(note) },
        );
        if (!n.ok) {
          onOpenChange(true);
          toast.error(n.error);
          router.refresh();
          return;
        }
      }
      if (!valueChanged) {
        if (renamed || noteChanged)
          toast.success(renamed ? "Variable renamed" : "Note saved");
        router.refresh();
        return;
      }
      // No `targets`: the server defaults every variable to every runtime.
      const res = await gqlAction<{ upsertEnv: SavedVar }>(
        `mutation($input: UpsertEnvInput!) {
          upsertEnv(input: $input) { key connected database { name } }
        }`,
        {
          input: {
            appId,
            key: trimmedKey,
            value,
            type: secret ? "secret" : "plain",
            ...(noteChanged && { note: cleanNote(note) ?? "" }),
          },
        },
      );
      if (res.ok) savedToast("Variable updated", linkedOf(res.data?.upsertEnv));
      else {
        onOpenChange(true);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {noteOnly
              ? "Edit note"
              : editing.connected
                ? "Rename variable"
                : "Edit variable"}
          </DialogTitle>
          <DialogDescription>
            {noteOnly ? (
              <>
                Say what <strong>{editing.key}</strong> is for. A secret&apos;s
                value can&apos;t be changed.
              </>
            ) : editing.connected ? (
              "Its value comes from the connected database."
            ) : (
              "Update this variable's name, value or note."
            )}
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            {!noteOnly && (
              <div className="space-y-2">
                <FieldLabel
                  info="The variable's name, exposed to your app during builds and at runtime. Renaming it takes effect on the next deploy."
                  docs="env.overview"
                >
                  Key
                </FieldLabel>
                <Input
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                  spellCheck={false}
                  aria-invalid={trimmedKey !== "" && !keyValid}
                  className={cn(
                    "font-mono text-sm",
                    trimmedKey !== "" &&
                      !keyValid &&
                      "border-destructive text-destructive focus-visible:ring-destructive",
                  )}
                />
                {trimmedKey !== "" && !keyValid && (
                  <p className="text-xs text-destructive">
                    Names must start with a letter or underscore and contain
                    only letters, digits and underscores.
                  </p>
                )}
              </div>
            )}
            {!editing.connected && !noteOnly && (
              <>
                <div className="space-y-2">
                  <Label>Value</Label>
                  <Textarea
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    placeholder="Enter a new value"
                    rows={3}
                    autoFocus
                  />
                </div>
                <SecretRow secret={secret} onChange={setSecret} />
              </>
            )}
            <NoteField value={note} onChange={setNote} autoFocus={noteOnly} />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !keyValid}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export type AutoLinked = { key: string; database: string };
export type SavedVar = {
  key: string;
  connected: boolean;
  database: { name: string } | null;
};

export const linkedOf = (v?: SavedVar): AutoLinked[] =>
  v?.connected
    ? [{ key: v.key, database: v.database?.name ?? "its database" }]
    : [];

// A value that is a database's connection string is connected on save: say so.
export function savedToast(done: string, linked: AutoLinked[]) {
  toast.success(
    done,
    linked.length > 0
      ? {
          description: linked
            .map((l) => `${l.key} now follows ${l.database}`)
            .join(", "),
        }
      : undefined,
  );
}
