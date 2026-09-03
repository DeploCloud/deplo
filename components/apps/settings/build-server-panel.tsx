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
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import { gqlAction } from "@/lib/graphql-client";

export interface BuildServerChoice {
  id: string;
  name: string;
  /** "amd64" | "arm64", or "" when the agent is too old to report one. */
  hostArch: string;
  /** True for a host dedicated to building; false for an ordinary server. */
  buildOnly: boolean;
  /** True when this host builds for an app whose own build server is down. */
  buildFallback: boolean;
  isDeploHost: boolean;
}

/** The stored value's three meanings, as one select value. `AUTOMATIC` and `SELF`
 *  are not server ids, and no server id can collide with them (ids are `srv_…`). */
const AUTOMATIC = "__auto__";
const SELF = "__self__";

/**
 * Where this app COMPILES, when that is not where it runs. It saves on change
 * rather than joining a Save button, like every other panel in that card, and
 * changing it never starts a deploy: it decides where the NEXT build happens.
 */
export function BuildServerPanel({
  appId,
  serverId,
  serverName,
  serverArch,
  buildServerId,
  buildFallback,
  choices,
}: {
  appId: string;
  /** The server the app RUNS on - the "build here" option, and the arch to match. */
  serverId: string;
  serverName: string;
  serverArch: string;
  buildServerId: string | null;
  buildFallback: boolean;
  choices: BuildServerChoice[];
}) {
  const router = useRouter();
  const [saving, startTransition] = React.useTransition();
  const [value, setValue] = React.useState(
    buildServerId === null
      ? AUTOMATIC
      : buildServerId === serverId
        ? SELF
        : buildServerId,
  );
  const [fallback, setFallback] = React.useState(buildFallback);

  // Everything except the app's own server, which is the SELF option above.
  const others = choices.filter((c) => c.id !== serverId);
  const compatible = (c: BuildServerChoice) =>
    c.hostArch !== "" && serverArch !== "" && c.hostArch === serverArch;
  // Whether Automatic would actually find anything. Said out loud, because
  // "Automatic" on a fleet with no build server is a setting that does nothing, and
  // silently doing nothing is what makes people distrust a control.
  const autoWouldUse = others.some((c) => c.buildOnly && compatible(c));
  // Where a build actually goes when the chosen server cannot take it. The Deplo
  // host first, exactly as the deploy resolves it (lib/deploy/build-server.ts).
  const fallbackName = others
    .filter((c) => c.buildFallback && compatible(c) && c.id !== value)
    .sort((a, b) => Number(b.isDeploHost) - Number(a.isDeploHost))[0]?.name;

  function save(next: { buildServerId: string | null; fallback: boolean }) {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $buildServerId: String, $buildFallback: Boolean) {
          setAppBuildServer(id: $id, buildServerId: $buildServerId, buildFallback: $buildFallback) { id }
        }`,
        {
          id: appId,
          buildServerId: next.buildServerId,
          buildFallback: next.fallback,
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
        setFallback(buildFallback);
        toast.error(res.error);
      }
    });
  }

  function pick(next: string) {
    setValue(next);
    save({
      buildServerId:
        next === AUTOMATIC ? null : next === SELF ? serverId : next,
      fallback,
    });
  }

  function toggleFallback(next: boolean) {
    setFallback(next);
    save({
      buildServerId:
        value === AUTOMATIC ? null : value === SELF ? serverId : value,
      fallback: next,
    });
  }

  // The fallback only means anything while a build actually happens elsewhere.
  const buildsElsewhere =
    value !== SELF && (value !== AUTOMATIC || autoWouldUse);

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
                  Which server compiles this app. Building somewhere else keeps
                  the server that runs it free of the load, and the finished
                  image is copied over. Only servers with the same CPU
                  architecture can build for this one.
                </>
              }
              docs="build.serversHowItWorks"
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
            <SelectItem value={SELF}>
              {serverName} (this app&apos;s server)
            </SelectItem>
            {others.map((c) => (
              <SelectItem key={c.id} value={c.id} disabled={!compatible(c)}>
                <span className="flex items-center gap-2">
                  {c.name}
                  {!compatible(c) &&
                    (c.hostArch === "" || serverArch === ""
                      ? " - architecture unknown"
                      : ` - ${c.hostArch}, not ${serverArch}`)}
                  <ServerRoleHint isDeploHost={c.isDeploHost} />
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {buildsElsewhere && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
          <div className="space-y-0.5">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              Build somewhere else if that server is down
              <InfoTip
                content={
                  <>
                    Servers are marked as a build fallback in Settings →
                    Servers. The Deplo host is one until you say otherwise.
                  </>
                }
                docs="build.serversHowItWorks"
              />
            </p>
            <p className="text-xs text-muted-foreground">
              {fallback
                ? `A deploy still ships, building on ${fallbackName ?? serverName} instead.`
                : `The deploy fails instead. Nothing else is asked to build.`}
            </p>
          </div>
          <Switch
            checked={fallback}
            onCheckedChange={toggleFallback}
            disabled={saving}
            aria-label="Build somewhere else if the build server is down"
          />
        </div>
      )}
    </div>
  );
}
