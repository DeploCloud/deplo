"use client";

import * as React from "react";
import { ChevronDown, Cloud, Plus, Server } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
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
import { usePendingCreate } from "@/components/shared/pending-create";
import { gqlAction } from "@/lib/graphql-client";
import { KindCard } from "@/components/shared/kind-card";
import { cn } from "@/lib/utils";
import type { DestinationKind, S3Provider } from "@/lib/types";

// Inlined (lib/data/destinations is server-only and cannot be imported here).
const PROVIDERS: { id: S3Provider; name: string; endpointHint: string }[] = [
  { id: "aws", name: "Amazon S3", endpointHint: "https://s3.us-east-1.amazonaws.com" },
  { id: "cloudflare-r2", name: "Cloudflare R2", endpointHint: "https://<account>.r2.cloudflarestorage.com" },
  { id: "backblaze-b2", name: "Backblaze B2", endpointHint: "https://s3.us-west-001.backblazeb2.com" },
  { id: "digitalocean", name: "DigitalOcean Spaces", endpointHint: "https://fra1.digitaloceanspaces.com" },
  { id: "wasabi", name: "Wasabi", endpointHint: "https://s3.eu-central-1.wasabisys.com" },
  { id: "minio", name: "MinIO (self-hosted)", endpointHint: "https://minio.example.com" },
  { id: "other", name: "Other S3-compatible", endpointHint: "https://..." },
];

/**
 * The endpoint to send, or "" when there is nothing usable. Blank means "use the
 * provider's default", which is right for every provider whose hint is a real
 * URL — and wrong for "other", whose hint is a placeholder shape.
 */
function endpointOrHint(typed: string, hint: string): string {
  const value = typed.trim() || hint;
  return value.includes("...") ? "" : value;
}

export interface DestinationServerOption {
  id: string;
  name: string;
  storageOnly: boolean;
}

const EMPTY_S3 = {
  endpoint: "",
  region: "auto",
  bucket: "",
  accessKey: "",
  secretKey: "",
};

export function CreateDestination({
  canCreate,
  servers,
  isInstanceAdmin,
  autoOpen = false,
}: {
  /** Whether the current user may add a destination (`manage_backup_destinations`).
   *  False shows the button disabled with a tooltip saying so, and nothing can
   *  open the dialog — not even the ?new=destination deep link. */
  canCreate: boolean;
  /** Servers this team can already reach, i.e. the same list the deploy picker
   *  offers. A member must not discover a host they cannot otherwise see. */
  servers: DestinationServerOption[];
  /** A custom folder is instance-admin only: the default path carries no
   *  privilege, an arbitrary absolute path on a shared host does. */
  isInstanceAdmin: boolean;
  autoOpen?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen && canCreate);
  const { create } = usePendingCreate();

  // Arrived via ?new=destination (e.g. from an app's "no destination" banner) →
  // drop the param so a refresh or Back doesn't reopen the dialog.
  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Server first: it is the one that needs no account anywhere, and on a fresh
  // instance it is the only one that can be filled in without leaving the page.
  const [kind, setKind] = React.useState<DestinationKind>("server");
  const [name, setName] = React.useState("");
  const [serverId, setServerId] = React.useState(servers[0]?.id ?? "");
  const [path, setPath] = React.useState("");
  const [advancedOpen, setAdvancedOpen] = React.useState(false);
  const [provider, setProvider] = React.useState<S3Provider>("cloudflare-r2");
  const [s3, setS3] = React.useState(EMPTY_S3);
  const [allowPrivate, setAllowPrivate] = React.useState(false);

  const hint = PROVIDERS.find((p) => p.id === provider)!.endpointHint;
  const setField = (k: keyof typeof s3) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setS3((f) => ({ ...f, [k]: e.target.value }));

  // The button asks for everything the SERVER asks for. It used to check only
  // the bucket, so a form missing its keys closed, failed, and reopened with the
  // error - which is a slower way of saying "this field is required".
  const valid =
    kind === "server"
      ? Boolean(serverId) && servers.length > 0
      : Boolean(s3.bucket.trim()) &&
        Boolean(s3.accessKey.trim()) &&
        Boolean(s3.secretKey.trim()) &&
        Boolean(endpointOrHint(s3.endpoint, hint));

  function reset() {
    setName("");
    setPath("");
    setAdvancedOpen(false);
    setS3(EMPTY_S3);
    setAllowPrivate(false);
  }

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    // The destination shows up in the grid immediately, pulsing, while it is
    // verified. The whole form is kept aside: this is the create most likely to
    // be rejected (a wrong key, a folder that is not empty), and retyping six
    // fields would be the worst possible answer.
    const typed = { kind, name, serverId, path, provider, allowPrivate, ...s3 };
    const serverName = servers.find((s) => s.id === typed.serverId)?.name ?? "";
    setOpen(false);
    reset();
    create(
      {
        label: typed.name || (typed.kind === "server" ? serverName : typed.bucket),
        note: "Checking destination",
      },
      () =>
        gqlAction(
          `mutation($input: CreateDestinationInput!) { createDestination(input: $input) { id } }`,
          {
            input:
              typed.kind === "server"
                ? {
                    name: typed.name || serverName,
                    kind: "server",
                    serverId: typed.serverId,
                    path: typed.path.trim() || null,
                  }
                : {
                    name: typed.name || typed.bucket,
                    kind: "s3",
                    provider: typed.provider.toUpperCase().replace(/-/g, "_"),
                    // The provider hint is a real endpoint for every provider but
                    // "other", whose placeholder is literally "https://..." — a
                    // string that parses as a URL and resolves to nothing, so it
                    // used to be saved as a destination that could never work.
                    endpoint: endpointOrHint(typed.endpoint, hint),
                    region: typed.region,
                    bucket: typed.bucket,
                    accessKey: typed.accessKey,
                    secretKey: typed.secretKey,
                    allowPrivateEndpoint: typed.allowPrivate,
                  },
          },
        ),
      {
        success: "Backup destination added",
        onError: () => {
          setKind(typed.kind);
          setName(typed.name);
          setServerId(typed.serverId);
          setPath(typed.path);
          setProvider(typed.provider);
          setAllowPrivate(typed.allowPrivate);
          setS3({
            endpoint: typed.endpoint,
            region: typed.region,
            bucket: typed.bucket,
            accessKey: typed.accessKey,
            secretKey: typed.secretKey,
          });
          setAdvancedOpen(Boolean(typed.path));
          setOpen(true);
        },
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          {canCreate ? (
            <DialogTrigger asChild>
              <Button size="sm">
                <Plus className="size-4" />
                Add Destination
              </Button>
            </DialogTrigger>
          ) : (
            // Disabled buttons swallow pointer events, so wrap in a focusable
            // span to keep the tooltip reachable. No DialogTrigger here means a
            // click can never open a dialog the server would refuse.
            <span tabIndex={0}>
              <Button size="sm" disabled>
                <Plus className="size-4" />
                Add Destination
              </Button>
            </span>
          )}
        </TooltipTrigger>
        <TooltipContent>
          {canCreate
            ? "Add somewhere to keep backups"
            : "You don't have permission to add backup destinations"}
        </TooltipContent>
      </Tooltip>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add backup destination</DialogTitle>
          <DialogDescription>
            Where this team&apos;s backups are kept.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div
              role="radiogroup"
              aria-label="Destination type"
              className="grid grid-cols-2 gap-3"
            >
              <KindCard
                selected={kind === "server"}
                onSelect={() => setKind("server")}
                icon={<Server className="size-4" />}
                title="Server"
                caption="A folder on one of your servers"
                badge={
                  <Badge variant="info" className="text-[10px] font-normal">
                    Beta
                  </Badge>
                }
              />
              <KindCard
                selected={kind === "s3"}
                onSelect={() => setKind("s3")}
                icon={<Cloud className="size-4" />}
                title="S3 bucket"
                caption="Any S3-compatible storage"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="destination-name">Name</Label>
              <Input
                id="destination-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={kind === "server" ? "Nightly backups" : "Backups bucket"}
              />
            </div>

            {kind === "server" ? (
              <ServerFields
                servers={servers}
                serverId={serverId}
                onServerChange={setServerId}
                path={path}
                onPathChange={setPath}
                isInstanceAdmin={isInstanceAdmin}
                advancedOpen={advancedOpen}
                onAdvancedToggle={() => setAdvancedOpen((v) => !v)}
              />
            ) : (
              <>
                <div className="space-y-2">
                  <FieldLabel info="Picks the S3-compatible service. Choosing one pre-fills the matching endpoint format below.">
                    Provider
                  </FieldLabel>
                  <Select
                    value={provider}
                    onValueChange={(v) => setProvider(v as S3Provider)}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PROVIDERS.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <FieldLabel info="The S3 API URL for your bucket. Leave blank to use the default endpoint for the selected provider.">
                    Endpoint
                  </FieldLabel>
                  <Input
                    value={s3.endpoint}
                    onChange={setField("endpoint")}
                    placeholder={hint}
                    className="font-mono text-xs"
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <FieldLabel
                      info={
                        <>
                          The bucket&apos;s region. Use{" "}
                          <code className="font-mono">auto</code> for providers like
                          Cloudflare R2 that don&apos;t require a specific region.
                        </>
                      }
                    >
                      Region
                    </FieldLabel>
                    <Input value={s3.region} onChange={setField("region")} placeholder="auto" />
                  </div>
                  <div className="space-y-2">
                    <Label>Bucket</Label>
                    <Input value={s3.bucket} onChange={setField("bucket")} placeholder="my-bucket" />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label>Access Key ID</Label>
                  <Input
                    value={s3.accessKey}
                    onChange={setField("accessKey")}
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Secret Access Key</Label>
                  <Input
                    type="password"
                    value={s3.secretKey}
                    onChange={setField("secretKey")}
                    className="font-mono text-xs"
                    autoComplete="off"
                  />
                </div>
                {/* Self-hosting means the bucket is often on the same private
                    network as the fleet, and both guards refused that outright -
                    so "MinIO (self-hosted)" was in the list and unusable at any
                    ordinary address. Instance admins only, the same bar a custom
                    backup folder carries, because the agent dials it as root. */}
                {isInstanceAdmin && (
                  <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-3 text-sm">
                    <Checkbox
                      checked={allowPrivate}
                      onCheckedChange={(v) => setAllowPrivate(v === true)}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="font-medium">
                        This bucket is on my own network
                      </span>
                      <span className="mt-1 block text-xs text-muted-foreground">
                        Allows a private address like 10.0.0.5 or a hostname that
                        resolves to one. Off by default so a mistyped endpoint
                        cannot reach inside your network.
                      </span>
                    </span>
                  </label>
                )}
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid}>
              Add destination
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ServerFields({
  servers,
  serverId,
  onServerChange,
  path,
  onPathChange,
  isInstanceAdmin,
  advancedOpen,
  onAdvancedToggle,
}: {
  servers: DestinationServerOption[];
  serverId: string;
  onServerChange: (v: string) => void;
  path: string;
  onPathChange: (v: string) => void;
  isInstanceAdmin: boolean;
  advancedOpen: boolean;
  onAdvancedToggle: () => void;
}) {
  if (servers.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-secondary/40 p-3 text-xs text-muted-foreground">
        No server is connected yet. Connect one first, or use an S3 bucket.
      </p>
    );
  }
  return (
    <>
      <div className="space-y-2">
        <FieldLabel info="The server whose disk holds the backup files. Backups of apps on other servers are copied here.">
          Server
        </FieldLabel>
        <Select value={serverId} onValueChange={onServerChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select a server" />
          </SelectTrigger>
          <SelectContent>
            {servers.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                <span className="flex items-center gap-2">
                  <Server className="size-4 text-muted-foreground" />
                  {s.name}
                  {s.storageOnly && (
                    <Badge variant="muted" className="text-[10px] font-normal">
                      Storage only
                    </Badge>
                  )}
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Advanced: the folder. Everyone else gets the one Deplo manages, which
          is the whole point of not asking. Instance admins only, because an
          arbitrary absolute path on a shared host is an instance-level call. */}
      {isInstanceAdmin && (
        <div className="rounded-lg border border-border">
          <button
            type="button"
            aria-expanded={advancedOpen}
            onClick={onAdvancedToggle}
            className="flex w-full cursor-pointer items-center justify-between gap-2 rounded-lg px-4 py-3 text-left text-sm transition-colors hover:bg-accent/40"
          >
            <span>Advanced</span>
            <span className="flex min-w-0 items-center gap-2">
              {!advancedOpen && (
                <span className="truncate text-xs text-muted-foreground">
                  {path.trim() || "Managed folder"}
                </span>
              )}
              <ChevronDown
                className={cn(
                  "size-4 shrink-0 text-muted-foreground transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
            </span>
          </button>
          {advancedOpen && (
            <div className="border-t border-border p-4">
              <div className="space-y-2">
                <FieldLabel info="An absolute path that ALREADY EXISTS on that server, for example a mounted storage volume, and is empty the first time it is used. Leave blank to let Deplo create and manage the folder.">
                  Folder
                </FieldLabel>
                <Input
                  value={path}
                  onChange={(e) => onPathChange(e.target.value)}
                  placeholder="/mnt/backups"
                  className="font-mono text-xs"
                />
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
