"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus } from "lucide-react";
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
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
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
import { RevealInput } from "@/components/ui/password-field";
import { Combobox } from "@/components/shared/combobox";
import { AnimatedHeight } from "@/components/shared/animated-height";
import { ServerRoleHint } from "@/components/shared/server-role-hint";
import { useRouter } from "@/lib/nav";
import { usePendingCreate } from "@/components/shared/pending-create";
import { gqlAction } from "@/lib/graphql-client";
import { generatePassword } from "@/lib/password-policy";
import { DB_NAMES, DB_TYPES as TYPES, ENGINE_CREDS } from "./db-engines";
import { DatabaseLogo } from "./database-logo";
import { DbVersionInput } from "./db-version-input";
import type { DatabaseType } from "@/lib/types/database";
import {
  EnvironmentCombobox,
  NO_ENVIRONMENT,
  type EnvironmentOption,
} from "./environment-combobox";

export function CreateDatabase({
  servers,
  environments = [],
  canCreate,
  canExposePorts = false,
  autoOpen = false,
  size = "default",
}: {
  servers: { id: string; name: string; isDeploHost: boolean }[];
  environments?: EnvironmentOption[];
  canCreate: boolean;
  canExposePorts?: boolean;
  autoOpen?: boolean;
  size?: "sm" | "default";
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(
    autoOpen && canCreate && servers.length > 0,
  );
  const [pending, startTransition] = React.useTransition();
  const { create } = usePendingCreate();

  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<DatabaseType>("postgres");
  const [version, setVersion] = React.useState(
    TYPES.find((t) => t.id === "postgres")!.versions[0],
  );
  const [serverId, setServerId] = React.useState<string>(servers[0]?.id ?? "");
  const [environmentId, setEnvironmentId] =
    React.useState<string>(NO_ENVIRONMENT);
  const [username, setUsername] = React.useState("");
  const [dbName, setDbName] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [showPassword, setShowPassword] = React.useState(false);
  const [exposed, setExposed] = React.useState(false);
  const [port, setPort] = React.useState("");
  const [generatingPort, setGeneratingPort] = React.useState(false);

  const creds = ENGINE_CREDS[type];
  const noServers = servers.length === 0;
  const blocked = !canCreate
    ? "You don't have permission to create databases"
    : noServers
      ? "Provision a server first"
      : null;
  // A soft router.refresh() reconciles `servers` in place, so the mount-only initializer can be stale.
  const effectiveServerId =
    servers.find((s) => s.id === serverId)?.id ?? servers[0]?.id ?? "";

  function onTypeChange(v: string) {
    const t = v as DatabaseType;
    setType(t);
    setVersion(TYPES.find((x) => x.id === t)!.versions[0]);
    setUsername("");
    setDbName("");
    setPassword("");
    setShowPassword(false);
  }

  function generatePort() {
    if (!effectiveServerId) return;
    setGeneratingPort(true);
    startTransition(async () => {
      const res = await gqlAction<{ generateAvailableDbPort: number }, number>(
        `mutation($serverId: ID) { generateAvailableDbPort(serverId: $serverId) }`,
        { serverId: effectiveServerId },
        (d) => d.generateAvailableDbPort,
      );
      setGeneratingPort(false);
      if (res.ok) setPort(String(res.data));
      else toast.error(res.error);
    });
  }

  const parsedPort = Number.parseInt(port, 10);
  const portValid =
    Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65535;
  const exposeReady = !exposed || portValid;

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    const typed = {
      name: name.trim(),
      type,
      version,
      serverId: effectiveServerId || null,
      environmentId: environmentId === NO_ENVIRONMENT ? null : environmentId,
      username: creds.username && username.trim() ? username.trim() : null,
      dbName: creds.dbName && dbName.trim() ? dbName.trim() : null,
      password: creds.password && password ? password : null,
      exposedPublicly: exposed,
      exposedPort: exposed ? parsedPort : null,
    };
    const restore = { username, dbName, password, showPassword, exposed, port };
    setOpen(false);
    setName("");
    setUsername("");
    setDbName("");
    setPassword("");
    setShowPassword(false);
    setExposed(false);
    setPort("");
    create(
      { label: typed.name, note: `Creating ${DB_NAMES[type]}…` },
      () =>
        gqlAction<{ createDatabase: { id: string } }, { id: string }>(
          `mutation($input: CreateDatabaseInput!) {
          createDatabase(input: $input) { id }
        }`,
          { input: typed },
          (d) => d.createDatabase,
        ),
      {
        success: `Database ${typed.name} is provisioning`,
        onError: () => {
          setName(typed.name);
          setType(typed.type);
          setVersion(typed.version);
          setUsername(restore.username);
          setDbName(restore.dbName);
          setPassword(restore.password);
          setShowPassword(restore.showPassword);
          setExposed(restore.exposed);
          setPort(restore.port);
          setOpen(true);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {blocked ? (
            <span tabIndex={0}>
              <Button size={size} disabled>
                <Plus className="size-4" />
                New Database
              </Button>
            </span>
          ) : (
            <DialogTrigger asChild>
              <Button size={size}>
                <Plus className="size-4" />
                New Database
              </Button>
            </DialogTrigger>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {blocked ?? "Create a managed database"}
        </TooltipContent>
      </Tooltip>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create database</DialogTitle>
          <DialogDescription>
            Spin up a managed database container on your server.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <AnimatedHeight className="space-y-4" scroll={false}>
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
                <Label htmlFor="db-engine">Engine</Label>
                <Combobox
                  id="db-engine"
                  items={TYPES}
                  value={type}
                  onChange={onTypeChange}
                  getKey={(t) => t.id}
                  matches={(t, q) =>
                    t.id.includes(q) || t.name.toLowerCase().includes(q)
                  }
                  displayValue={(t) => t.name}
                  renderLeading={(t) => <DatabaseLogo type={t.id} size={16} />}
                  renderOption={(t) => (
                    <span className="flex items-center gap-2 text-sm">
                      <DatabaseLogo type={t.id} size={16} />
                      {t.name}
                    </span>
                  )}
                  placeholder="Select an engine"
                  searchPlaceholder="Search engines"
                  emptyLabel={() => "No engine found"}
                />
              </div>
              <div className="space-y-2">
                <FieldLabel
                  info="Any published Docker Hub tag works - suggestions load as you type. Pick the version your app targets."
                  docs="databases.engine"
                >
                  Version
                </FieldLabel>
                <DbVersionInput
                  engine={type}
                  value={version}
                  onChange={setVersion}
                />
              </div>
            </div>
            <div className="space-y-3 rounded-lg border border-border p-3">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                Credentials
                <InfoTip content="Optional. Leave blank to use generated defaults. These are set only when the database is first created and can't be changed later." />
              </p>
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
                    <div className="min-w-0 flex-1">
                      <RevealInput
                        id="db-pass"
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        visible={showPassword}
                        onVisibleChange={setShowPassword}
                        placeholder="auto-generated"
                        autoComplete="new-password"
                        className="font-mono"
                      />
                    </div>
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
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((s) => (
                      <SelectItem key={s.id} value={s.id}>
                        <span className="flex items-center gap-2">
                          {s.name}
                          <ServerRoleHint isDeploHost={s.isDeploHost} />
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {environments.length > 0 && (
              <div className="space-y-2">
                <FieldLabel
                  info="Apps reach this database by name only from the same environment and the same server: a network does not span machines."
                  docs="network.isolation"
                >
                  Environment
                </FieldLabel>
                <EnvironmentCombobox
                  value={environmentId}
                  onChange={setEnvironmentId}
                  environments={environments}
                />
              </div>
            )}
            <div className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Expose publicly</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Publish the port to the internet. Keep off unless required.
                  </p>
                </div>
                {canExposePorts ? (
                  <Switch checked={exposed} onCheckedChange={setExposed} />
                ) : (
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
                    info="The port on the server clients connect to. Use an unprivileged port (1024-65535) that is free on the host, or click Generate."
                    docs="databases.hostPort"
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
          </AnimatedHeight>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                pending || !name.trim() || !effectiveServerId || !exposeReady
              }
            >
              Create database
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
