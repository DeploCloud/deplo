"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Eye, EyeOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useRouter } from "next/navigation";
import { gqlAction } from "@/lib/graphql-client";
import { generatePassword } from "@/lib/utils";
import { DB_TYPES as TYPES, ENGINE_CREDS } from "./db-engines";
import { DbVersionInput } from "./db-version-input";
import type { DatabaseType } from "@/lib/types";

export function CreateDatabase({
  servers,
  canExposePorts = false,
  autoOpen = false,
}: {
  servers: { id: string; name: string }[];
  /**
   * Whether the current user holds the publish-ports grant. When false the
   * "Expose publicly" control is shown DISABLED with an explanatory tooltip —
   * the toggle can't be turned on, so no port field ever appears. The server
   * re-checks this grant on create regardless (this only hides the affordance).
   */
  canExposePorts?: boolean;
  /**
   * Open the dialog on mount — used when arriving from the Overview "New
   * database" action (which links to /storage?new=database). Ignored when no
   * server is provisioned yet, since the form can't be submitted anyway.
   */
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen && servers.length > 0);
  const [pending, startTransition] = React.useTransition();

  // Arrived via ?new=database → drop the param so a refresh or Back doesn't
  // reopen the dialog. router.replace is not a setState, so this stays clear of
  // the effect-lint; runs once on mount.
  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<DatabaseType>("postgres");
  // Default to the newest fallback major; the live picker (DbVersionInput)
  // fetches the real Docker Hub tag list when the user opens it.
  const [version, setVersion] = React.useState(
    TYPES.find((t) => t.id === "postgres")!.versions[0],
  );
  const [serverId, setServerId] = React.useState<string>(servers[0]?.id ?? "");
  // Optional per-engine credentials. Blank => the server's generated defaults.
  const [username, setUsername] = React.useState("");
  const [dbName, setDbName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [exposed, setExposed] = React.useState(false);
  // The host port to publish when `exposed`. Kept as a string so the field can be
  // cleared/typed freely; parsed on submit. Empty until the user types or clicks
  // "Generate". A single generate can be in flight (`generatingPort`).
  const [port, setPort] = React.useState("");
  const [generatingPort, setGeneratingPort] = React.useState(false);

  const creds = ENGINE_CREDS[type];
  const noServers = servers.length === 0;
  // The useState initializer runs only on mount, but `servers` arrives via a
  // soft router.refresh() that reconciles this component in place (no remount) —
  // e.g. when a server finishes provisioning while the page is open (0→1). Derive
  // the effective id from the live prop so a stale "" never blocks a valid submit
  // (which would otherwise be unrecoverable without a full reload, since the
  // <Select> only renders for >1 server).
  const effectiveServerId =
    servers.find((s) => s.id === serverId)?.id ?? servers[0]?.id ?? "";

  function onTypeChange(v: string) {
    const t = v as DatabaseType;
    setType(t);
    setVersion(TYPES.find((x) => x.id === t)!.versions[0]);
    // Reset the per-engine credential fields so a value typed for one engine
    // (e.g. a username before switching to Redis, which has none) never rides
    // along in the submit payload for an engine that doesn't support it.
    setUsername("");
    setDbName("");
    setPassword("");
    setShowPassword(false);
  }

  // Ask the server for a host port that is currently free on the target server
  // (it probes the owning agent), then drop it into the field. The value is only
  // a suggestion — createDatabase re-checks it, so a race between this and submit
  // is still caught server-side.
  function generatePort() {
    if (!effectiveServerId) return;
    setGeneratingPort(true);
    startTransition(async () => {
      const res = await gqlAction<
        { generateAvailableDbPort: number },
        number
      >(
        `mutation($serverId: ID) { generateAvailableDbPort(serverId: $serverId) }`,
        { serverId: effectiveServerId },
        (d) => d.generateAvailableDbPort,
      );
      setGeneratingPort(false);
      if (res.ok) setPort(String(res.data));
      else toast.error(res.error);
    });
  }

  // When exposing, the port must be a valid unprivileged port before we submit —
  // the server rejects anything else, but catching it here gives instant feedback.
  const parsedPort = Number.parseInt(port, 10);
  const portValid =
    Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535;
  const exposeReady = !exposed || portValid;

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ createDatabase: { id: string } }, { id: string }>(
        `mutation($input: CreateDatabaseInput!) {
          createDatabase(input: $input) { id }
        }`,
        {
          input: {
            name,
            type,
            version,
            serverId: effectiveServerId || null,
            // Send a credential only when the engine supports it AND the user
            // filled it in; null keeps the server's generated default.
            username: creds.username && username.trim() ? username.trim() : null,
            dbName: creds.dbName && dbName.trim() ? dbName.trim() : null,
            password: creds.password && password ? password : null,
            exposedPublicly: exposed,
            // Only send a port when exposing; null keeps it internal-only.
            exposedPort: exposed ? parsedPort : null,
          },
        },
        (d) => d.createDatabase,
      );
      if (res.ok) {
        toast.success(`Database ${name} is provisioning`);
        setOpen(false);
        setName("");
        setUsername("");
        setDbName("");
        setPassword("");
        setShowPassword(false);
        setExposed(false);
        setPort("");
        // Straight to the new database's detail page, where the status flips
        // provisioning → running live (same "follow the thing you just made"
        // flow as creating an app).
        if (res.data?.id) router.push(`/storage/databases/${res.data.id}`);
        else router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {noServers ? (
            // Disabled buttons swallow pointer events, so wrap in a focusable
            // span to keep the tooltip reachable. No DialogTrigger here means a
            // click can never open the dialog while no server is provisioned.
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <Plus className="size-4" />
                New Database
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                New Database
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {noServers
            ? "Provision a server first"
            : "Create a managed database"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create database</DialogTitle>
          <DialogDescription>
            Spin up a managed database container on your server.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="db-name">Name</Label>
            <Input
              id="db-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-database"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label>Engine</Label>
              <Select value={type} onValueChange={onTypeChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPES.map((t) => (
                    <SelectItem key={t.id} value={t.id}>
                      <span className="flex items-center gap-2">
                        <t.icon className="size-4 text-muted-foreground" />
                        {t.name}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <FieldLabel info="The engine version to provision — the real Docker Hub tag list loads as you type, so new releases appear automatically. Pick the version your application targets, or type any published tag.">
                Version
              </FieldLabel>
              <DbVersionInput engine={type} value={version} onChange={setVersion} />
            </div>
          </div>
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Credentials</p>
              <p className="text-xs text-muted-foreground">
                Optional. Leave blank to use generated defaults. These are set
                only when the database is first created and can&apos;t be changed
                later.
              </p>
            </div>
            {creds.username && (
              <div className="space-y-1.5">
                <Label htmlFor="db-user">Username</Label>
                <Input
                  id="db-user"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder={creds.userDefault}
                  autoComplete="off"
                  className="font-mono"
                />
              </div>
            )}
            {creds.dbName && (
              <div className="space-y-1.5">
                <Label htmlFor="db-dbname">Database name</Label>
                <Input
                  id="db-dbname"
                  value={dbName}
                  onChange={(e) => setDbName(e.target.value)}
                  placeholder={`db-${name || "my-database"}`}
                  autoComplete="off"
                  className="font-mono"
                />
              </div>
            )}
            {creds.password && (
              <div className="space-y-1.5">
                <Label htmlFor="db-pass">Password</Label>
                <div className="flex gap-2">
                  <Input
                    id="db-pass"
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="auto-generated"
                    autoComplete="new-password"
                    className="font-mono"
                  />
                  <Button
                    type="button"
                    variant="outline"
                    size="icon"
                    onClick={() => setShowPassword((s) => !s)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setPassword(generatePassword());
                      setShowPassword(true);
                    }}
                  >
                    Generate
                  </Button>
                </div>
              </div>
            )}
          </div>
          {servers.length > 1 && (
            <div className="space-y-2">
              <Label>Server</Label>
              <Select value={serverId} onValueChange={setServerId}>
                <SelectTrigger>
                  <SelectValue placeholder="Select…" />
                </SelectTrigger>
                <SelectContent>
                  {servers.map((s) => (
                    <SelectItem key={s.id} value={s.id}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-3 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">Expose publicly</p>
                <p className="text-xs text-muted-foreground">
                  Publish the port to the internet. Keep off unless required.
                </p>
              </div>
              {canExposePorts ? (
                <Switch checked={exposed} onCheckedChange={setExposed} />
              ) : (
                // No permission: the switch is disabled and can never be turned
                // on, so the port field below never appears. A tooltip explains why.
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0}>
                      <Switch checked={false} disabled />
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    You don&apos;t have permission to publish ports
                  </TooltipContent>
                </Tooltip>
              )}
            </div>
            {exposed && (
              <div className="space-y-1.5">
                <FieldLabel
                  htmlFor="db-port"
                  info="The port on the server clients connect to. Use an unprivileged port (1024–65535) that is free on the host, or click Generate."
                >
                  Host port
                </FieldLabel>
                <div className="flex gap-2">
                  <Input
                    id="db-port"
                    inputMode="numeric"
                    value={port}
                    onChange={(e) =>
                      setPort(e.target.value.replace(/[^0-9]/g, ""))
                    }
                    placeholder="e.g. 25432"
                    aria-invalid={port !== "" && !portValid}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={generatePort}
                    disabled={generatingPort || pending || !effectiveServerId}
                  >
                    {generatingPort ? "Finding…" : "Generate"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={pending || !name.trim() || !effectiveServerId || !exposeReady}
          >
            {pending ? "Creating…" : "Create database"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
