"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { InfoTip } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { BetaChip } from "@/components/shared/beta-chip";
import { gqlAction } from "@/lib/graphql-client";

export interface BuildServerChoice {
  id: string;
  name: string;
  /** "amd64" | "arm64", or "" when the agent is too old to report one. */
  hostArch: string;
  /** True for a host dedicated to building; false for an ordinary server. */
  buildOnly: boolean;
}

/** The stored value's three meanings, as one select value. `AUTOMATIC` and `SELF`
 *  are not server ids, and no server id can collide with them (ids are `srv_…`). */
const AUTOMATIC = "__auto__";
const SELF = "__self__";

/**
 * Where this app COMPILES, when that is not where it runs.
 *
 * A build server lets a production box be sized for the workload instead of the
 * build: an app that serves in 300 MB can need several GB to compile, and while it
 * compiles it competes with the apps already running beside it.
 *
 * ADVANCED: the parent renders this in the Deployment page's "Advanced settings"
 * card, and only for an app Deplo actually builds - a compose stack has no single
 * image to move and a prebuilt image is not built at all. It saves on change rather
 * than joining a Save button, like every other panel in that card, and changing it
 * never starts a deploy: it decides where the NEXT build happens.
 *
 * A choice whose architecture differs from the app's own server is offered but
 * DISABLED, with the reason on the row. Hiding it would leave the operator hunting
 * for a server they can see in the fleet; an image built there would start on this
 * host and immediately die with `exec format error`.
 */
export function BuildServerPanel({
  appId,
  serverId,
  serverName,
  serverArch,
  buildServerId,
  buildFallbackLocal,
  choices,
}: {
  appId: string;
  /** The server the app RUNS on - the "build here" option, and the arch to match. */
  serverId: string;
  serverName: string;
  serverArch: string;
  buildServerId: string | null;
  buildFallbackLocal: boolean;
  choices: BuildServerChoice[];
}) {
  const router = useRouter();
  const [saving, startTransition] = React.useTransition();
  const [value, setValue] = React.useState(
    buildServerId === null ? AUTOMATIC : buildServerId === serverId ? SELF : buildServerId,
  );
  const [fallback, setFallback] = React.useState(buildFallbackLocal);

  // Everything except the app's own server, which is the SELF option above.
  const others = choices.filter((c) => c.id !== serverId);
  const compatible = (c: BuildServerChoice) =>
    c.hostArch !== "" && serverArch !== "" && c.hostArch === serverArch;
  // Whether Automatic would actually find anything. Said out loud, because
  // "Automatic" on a fleet with no build server is a setting that does nothing, and
  // silently doing nothing is what makes people distrust a control.
  const autoWouldUse = others.some((c) => c.buildOnly && compatible(c));

  function save(next: { buildServerId: string | null; fallback: boolean }) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $buildServerId: String, $buildFallbackLocal: Boolean) {
          setAppBuildServer(id: $id, buildServerId: $buildServerId, buildFallbackLocal: $buildFallbackLocal) { id }
        }`,
        {
          id: appId,
          buildServerId: next.buildServerId,
          buildFallbackLocal: next.fallback,
        },
      );
      if (res.ok) {
        toast.success("Build server saved");
        router.refresh();
      } else {
        // The server refused - go back to what it actually holds rather than
        // leaving the form showing a value nobody stored.
        setValue(
          buildServerId === null
            ? AUTOMATIC
            : buildServerId === serverId
              ? SELF
              : buildServerId,
        );
        setFallback(buildFallbackLocal);
        toast.error(res.error);
      }
    });
  }

  function pick(next: string) {
    setValue(next);
    save({
      buildServerId: next === AUTOMATIC ? null : next === SELF ? serverId : next,
      fallback,
    });
  }

  function toggleFallback(next: boolean) {
    setFallback(next);
    save({
      buildServerId: value === AUTOMATIC ? null : value === SELF ? serverId : value,
      fallback: next,
    });
  }

  // The fallback only means anything while a build actually happens elsewhere.
  const buildsElsewhere = value !== SELF && (value !== AUTOMATIC || autoWouldUse);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-0.5">
          <p className="flex items-center gap-1.5 text-sm font-medium">
            Build on
            <BetaChip />
            <InfoTip
              content={
                <>
                  Which server compiles this app. Building somewhere else keeps the
                  server that runs it free of the load, and the finished image is
                  copied over. Only servers with the same CPU architecture can build
                  for this one.
                </>
              }
            />
          </p>
          <p className="text-xs text-muted-foreground">
            {value === SELF
              ? `Always builds on ${serverName}, where it runs.`
              : value === AUTOMATIC
                ? autoWouldUse
                  ? "Uses a build server automatically."
                  : `No build server in this fleet yet, so it builds on ${serverName}.`
                : `Builds on ${others.find((c) => c.id === value)?.name ?? value}, then runs on ${serverName}.`}
          </p>
        </div>
        <Select value={value} onValueChange={pick} disabled={saving}>
          <SelectTrigger className="w-full shrink-0 sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTOMATIC}>Automatic</SelectItem>
            <SelectItem value={SELF}>{serverName} (this app&apos;s server)</SelectItem>
            {others.map((c) => (
              <SelectItem key={c.id} value={c.id} disabled={!compatible(c)}>
                {c.name}
                {!compatible(c) &&
                  (c.hostArch === "" || serverArch === ""
                    ? " - architecture unknown"
                    : ` - ${c.hostArch}, not ${serverArch}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {buildsElsewhere && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Build here if that server is down</p>
            <p className="text-xs text-muted-foreground">
              {fallback
                ? `A deploy still ships, building on ${serverName} instead.`
                : `The deploy fails instead. ${serverName} is never asked to build.`}
            </p>
          </div>
          <Switch
            checked={fallback}
            onCheckedChange={toggleFallback}
            disabled={saving}
            aria-label="Build here if the build server is down"
          />
        </div>
      )}
    </div>
  );
}
