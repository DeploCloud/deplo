"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useGraphqlMutation } from "@/lib/use-graphql";
import type { TraefikLabel } from "@/lib/deploy/traefik-overrides";
import { Save, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
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
    <form onSubmit={save}>
      <Card>
        <CardHeader>
          <CardTitle className="flex w-fit items-center gap-2 text-base">
            <Tags className="size-4 text-muted-foreground" />
            <label htmlFor="traefik-labels">Traefik labels</label>
            <InfoTip
              content="Override proxy settings with one key=value per line. Complete custom routes replace automatic routes."
              docs="build.advanced"
            />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
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
        </CardContent>
        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={dirty} />
          <Button
            type="submit"
            disabled={pending || !dirty}
            aria-busy={pending}
          >
            <Save className="size-4" />
            {pending ? "Saving" : "Save"}
          </Button>
        </CardFooter>
      </Card>
      <UnsavedChangesGuard when={dirty} />
    </form>
  );
}
