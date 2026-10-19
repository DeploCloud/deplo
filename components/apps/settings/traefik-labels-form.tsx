"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useGraphqlMutation } from "@/lib/use-graphql";
import type { TraefikLabel } from "@/lib/deploy/traefik-overrides";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";

export function TraefikLabelsForm({
  appId,
  labels,
}: {
  appId: string;
  labels: TraefikLabel[];
}) {
  const initial = labels.map(({ key, value }) => `${key}=${value}`).join("\n");
  const [text, setText] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const { run, pending, error } = useGraphqlMutation(/* GraphQL */ `
    mutation ($id: String!, $labels: [TraefikLabelInput!]!) {
      setAppTraefikLabels(id: $id, labels: $labels) {
        id
      }
    }
  `);
  useEffect(() => {
    if (error) toast.error(error);
  }, [error]);
  const dirty = text !== saved;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const committed = text;
    const entries = text.split("\n").filter((line) => line.trim());
    if (entries.some((line) => !line.includes("="))) {
      toast.error("Write one key=value label per line");
      return;
    }
    const result = await run({
      id: appId,
      labels: entries.map((line) => {
        const split = line.indexOf("=");
        return { key: line.slice(0, split), value: line.slice(split + 1) };
      }),
    });
    if (!result) return;
    setSaved(committed);
    toast.success("Traefik labels saved. Deploy to apply them.");
  }

  return (
    <form
      onSubmit={save}
      className="space-y-3 rounded-lg border border-border p-3"
    >
      <label htmlFor="traefik-labels" className="text-sm font-medium">
        Traefik labels
      </label>
      <p className="mt-1 text-xs text-muted-foreground">
        Override proxy settings with one key=value per line. Complete custom
        routes replace automatic routes.
      </p>
      <Textarea
        id="traefik-labels"
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={8}
        spellCheck={false}
        className="font-mono text-xs"
        disabled={pending}
        placeholder="traefik.enable=true"
        aria-describedby="traefik-labels-warning"
      />
      <p id="traefik-labels-warning" className="text-xs text-warning">
        These labels can affect other apps on this server. Image labels stay
        blocked; previews use automatic routing.
      </p>
      <Button type="submit" disabled={pending || !dirty} aria-busy={pending}>
        {pending ? "Saving" : "Save"}
      </Button>
      <UnsavedChangesGuard when={dirty} />
    </form>
  );
}
