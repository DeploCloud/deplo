"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Play,
  Square,
  Save,
  Trash2,
  Plus,
  KeyRound,
  Terminal,
  Copy,
  Code2,
  ExternalLink,
  Loader2,
  RotateCcw,
  UploadCloud,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { ConfirmAction } from "@/components/shared/confirm-action";
import {
  enableDevAction,
  disableDevAction,
  updateDevAction,
  startDevAction,
  stopDevAction,
  addDevSshUserAction,
  removeDevSshUserAction,
  startTunnelAction,
  getTunnelAction,
  stopTunnelAction,
  resetDevWorkspaceAction,
  deployDevWorkspaceAction,
} from "@/lib/actions/dev";
import type { VscodeTunnelInfo } from "@/lib/data/dev";
import type { DevImagePreset, DevSshUserDTO, DevStatus } from "@/lib/types";

export interface DevInfoProps {
  enabled: boolean;
  status: DevStatus;
  imageKind: "preset" | "custom";
  image: string;
  resolvedImage: string;
  devCommand: string;
  port: number;
  previewEnabled: boolean;
  previewUrl: string;
  eligible: boolean;
}

const PRESETS: DevImagePreset[] = [
  "node",
  "python",
  "go",
  "rust",
  "php",
  "java",
];

const STATUS_VARIANT: Record<
  DevStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  off: "outline",
  starting: "secondary",
  running: "default",
  stopped: "secondary",
  error: "destructive",
};

export function DevModeFields({
  projectId,
  host,
  dev,
  sshUsers,
}: {
  projectId: string;
  /** The SSH host users connect to (server IP / hostname). */
  host: string;
  dev: DevInfoProps;
  sshUsers: DevSshUserDTO[];
}) {
  const [pending, startTransition] = React.useTransition();
  const [enabled, setEnabled] = React.useState(dev.enabled);
  const [imageKind, setImageKind] = React.useState(dev.imageKind);
  const [image, setImage] = React.useState(dev.image);
  const [port, setPort] = React.useState(dev.port);
  const [previewEnabled, setPreviewEnabled] = React.useState(dev.previewEnabled);

  // SSH user form.
  const [users, setUsers] = React.useState<DevSshUserDTO[]>(sshUsers);
  const [newName, setNewName] = React.useState("");
  const [newKey, setNewKey] = React.useState("");
  const [newPassword, setNewPassword] = React.useState("");

  // VS Code Remote Tunnel.
  const [tunnel, setTunnel] = React.useState<VscodeTunnelInfo | null>(null);
  const [tunnelBusy, setTunnelBusy] = React.useState(false);
  // On a fresh page load the tunnel may already be running in the container, but
  // React state starts empty. Re-hydrate from the live container state once on
  // mount so a reload doesn't appear to drop a connected tunnel. `checking` shows
  // a placeholder until that first read resolves.
  const [tunnelChecking, setTunnelChecking] = React.useState(
    dev.status === "running",
  );

  React.useEffect(() => {
    // Only meaningful while the container is up — getTunnel does `docker exec`,
    // which fails for a stopped container. A non-running container has no tunnel,
    // and `tunnelChecking` already initialised to false for that case (no sync
    // setState here — the early return just skips the read).
    if (dev.status !== "running") return;
    let cancelled = false;
    (async () => {
      const res = await getTunnelAction(projectId);
      if (cancelled) return;
      // Adopt the live state only if a tunnel process is actually running; a
      // dead/never-started tunnel leaves the "Open in VS Code" button as-is.
      if (res.ok && res.data?.running) setTunnel(res.data);
      setTunnelChecking(false);
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount (per container-running session); the poll effect below
    // takes over for the device-login → connected transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function openInVscode() {
    setTunnelBusy(true);
    startTransition(async () => {
      const res = await startTunnelAction(projectId);
      setTunnelBusy(false);
      if (res.ok && res.data) {
        setTunnel(res.data);
        if (res.data.connected) toast.success("VS Code tunnel connected");
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  // Once the device-code is shown, poll until the tunnel actually CONNECTS
  // (registers with the relay). Until then the editor URL would 404, so we
  // never show it. Stops polling once connected.
  React.useEffect(() => {
    if (!tunnel?.loginUrl || tunnel?.connected) return;
    const t = setInterval(async () => {
      const res = await getTunnelAction(projectId);
      if (res.ok && res.data) {
        setTunnel(res.data);
        if (res.data.connected) {
          toast.success("VS Code tunnel connected");
          clearInterval(t);
        }
      }
    }, 4000);
    return () => clearInterval(t);
  }, [tunnel?.loginUrl, tunnel?.connected, projectId]);

  function closeTunnel() {
    startTransition(async () => {
      const res = await stopTunnelAction(projectId);
      if (res.ok) {
        setTunnel(null);
        toast.success("VS Code tunnel closed");
      } else toast.error(res.error);
    });
  }

  if (!dev.eligible) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dev Mode</CardTitle>
          <CardDescription>
            A live, editable dev container with hot reload and SSH access,
            alongside your production stack.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Dev mode is available only for projects with editable source
            (GitHub, Git, or Upload). This project deploys from a prebuilt image
            or a Compose stack, so there is no source tree to develop against.
          </p>
        </CardContent>
      </Card>
    );
  }

  function toggleEnabled(next: boolean) {
    setEnabled(next);
    startTransition(async () => {
      const res = next
        ? await enableDevAction(projectId)
        : await disableDevAction(projectId);
      if (res.ok) toast.success(next ? "Dev mode enabled" : "Dev mode disabled");
      else {
        toast.error(res.error);
        setEnabled(!next);
      }
    });
  }

  function saveContainerConfig() {
    startTransition(async () => {
      const res = await updateDevAction(projectId, { imageKind, image, port });
      if (res.ok) toast.success("Container settings saved");
      else toast.error(res.error);
    });
  }

  function savePreview() {
    startTransition(async () => {
      const res = await updateDevAction(projectId, { previewEnabled });
      if (res.ok) toast.success("Preview settings saved");
      else toast.error(res.error);
    });
  }

  function start() {
    startTransition(async () => {
      const res = await startDevAction(projectId);
      if (res.ok) {
        // A (re)start recreates the container, so any previous tunnel process is
        // gone and not auto-relaunched — clear the stale state. The login token
        // persists, so re-opening VS Code won't re-prompt for GitHub.
        setTunnel(null);
        toast.success("Dev container starting…");
      } else toast.error(res.error);
    });
  }

  function stop() {
    startTransition(async () => {
      const res = await stopDevAction(projectId);
      if (res.ok) {
        // Stopping the container also stops the VS Code tunnel (server-side, via
        // stopDev → stopVscodeTunnel). Clear the local tunnel state so the panel
        // drops back to "Open in VS Code" instead of showing a stale connection.
        setTunnel(null);
        toast.success("Dev container stopped");
      } else toast.error(res.error);
    });
  }

  async function resetWorkspace() {
    const res = await resetDevWorkspaceAction(projectId);
    if (res.ok) toast.success("Workspace reset from source");
    else toast.error(res.error);
    return res;
  }

  async function deployFromWorkspace() {
    const res = await deployDevWorkspaceAction(projectId);
    // Success toast only — ConfirmAction already toasts res.error on failure,
    // so we do NOT re-toast the error here (that would double it).
    if (res.ok) toast.success("Deploy from dev files started");
    return res;
  }

  function addUser() {
    if (!newName.trim()) {
      toast.error("Enter a username");
      return;
    }
    if (!newKey.trim() && !newPassword.trim()) {
      toast.error("Provide an SSH key or a password (at least one)");
      return;
    }
    startTransition(async () => {
      const res = await addDevSshUserAction({
        projectId,
        name: newName.trim(),
        publicKey: newKey.trim() || null,
        password: newPassword.trim() || null,
      });
      if (res.ok && res.data) {
        setUsers((u) => [...u, res.data!]);
        setNewName("");
        setNewKey("");
        setNewPassword("");
        toast.success(`SSH user ${res.data.username} added`);
      } else if (!res.ok) {
        toast.error(res.error);
      }
    });
  }

  async function removeUser(id: string, username: string) {
    const res = await removeDevSshUserAction(id);
    if (res.ok) {
      setUsers((u) => u.filter((x) => x.id !== id));
      toast.success(`Removed ${username}`);
    } else {
      toast.error(res.error);
    }
    return res;
  }

  return (
    <div className="space-y-6">
      {/* Dev Mode — enable toggle + container lifecycle */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dev Mode</CardTitle>
          <CardDescription>
            A live, editable dev container with hot reload and SSH access,
            alongside your production stack.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Enable + status */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <Label className="text-sm font-medium">Enable dev mode</Label>
              <p className="text-sm text-muted-foreground">
                Run a live, editable dev container alongside production, with
                hot reload and SSH access. The workspace persists across
                restarts.
              </p>
            </div>
            <Switch
              checked={enabled}
              onCheckedChange={toggleEnabled}
              disabled={pending}
            />
          </div>

          {enabled && (
            <div className="flex flex-wrap items-center gap-3">
              <Badge variant={STATUS_VARIANT[dev.status]}>{dev.status}</Badge>
              <Button
                size="sm"
                variant="outline"
                onClick={start}
                disabled={pending}
              >
                <Play className="size-4" />
                {dev.status === "running" ? "Restart" : "Start"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={stop}
                disabled={pending}
              >
                <Square className="size-4" />
                Stop
              </Button>
              <ConfirmAction
                trigger={
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={pending}
                  >
                    <RotateCcw className="size-4" />
                    Reset from source
                  </Button>
                }
                title="Reset workspace from source?"
                description="This replaces ALL files in the dev workspace with a fresh copy of the current deploy source, and reinstalls dependencies. Any uncommitted changes in the dev container are permanently lost. Use this after changing the deploy source."
                confirmLabel="Replace all files"
                onConfirm={resetWorkspace}
              />
              <ConfirmAction
                variant="default"
                trigger={
                  <Button size="sm" variant="outline" disabled={pending}>
                    <UploadCloud className="size-4" />
                    Deploy current files
                  </Button>
                }
                title="Deploy the current dev files to production?"
                description="This builds and deploys the files exactly as they are RIGHT NOW in the dev workspace — including uncommitted edits — and replaces the live production app with the result. Dependencies are reinstalled during the build, exactly like a normal deploy. It does NOT push to git or change your deploy source; it only ships this snapshot. The previous production version stays in your deployment history."
                confirmLabel="Build & deploy now"
                onConfirm={deployFromWorkspace}
              />
            </div>
          )}
        </CardContent>
      </Card>

      {enabled && (
        <Tabs defaultValue="vscode" className="space-y-6">
          <UnderlineTabsList>
            <UnderlineTabsTrigger value="vscode">
              <Code2 className="size-4" /> VS Code
            </UnderlineTabsTrigger>
            <UnderlineTabsTrigger value="container">
              Container
            </UnderlineTabsTrigger>
            <UnderlineTabsTrigger value="preview">
              Preview &amp; Env
            </UnderlineTabsTrigger>
            <UnderlineTabsTrigger value="ssh">
              <Terminal className="size-4" /> SSH Access
            </UnderlineTabsTrigger>
          </UnderlineTabsList>

          {/* Open in VS Code (Remote Tunnel) */}
          <TabsContent value="vscode" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Code2 className="size-4" /> Open in VS Code
              </CardTitle>
              <CardDescription>
                Runs a secure tunnel inside the dev container (no inbound
                ports). Authorize once, then edit in the desktop app or{" "}
                <span className="font-mono">vscode.dev</span>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-end gap-3">
              {tunnelChecking ? (
                <Button size="sm" variant="outline" disabled>
                  <Loader2 className="size-4 animate-spin" />
                  Checking VS Code tunnel…
                </Button>
              ) : !tunnel?.running ? (
                <Button
                  size="sm"
                  onClick={openInVscode}
                  disabled={pending || tunnelBusy || dev.status !== "running"}
                >
                  {tunnelBusy ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Code2 className="size-4" />
                  )}
                  Open in VS Code
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={closeTunnel}
                  disabled={pending}
                >
                  <Square className="size-4" />
                  {tunnel.connected ? "Close tunnel" : "Cancel"}
                </Button>
              )}
            </div>

            {dev.status !== "running" && !tunnel && (
              <p className="text-xs text-muted-foreground">
                Start the dev container first.
              </p>
            )}

            {/* Device-code step (awaiting authorization) */}
            {tunnel?.loginUrl && !tunnel.connected && (
              <div className="rounded-md bg-muted/50 p-3 text-sm">
                <p className="mb-2 font-medium">Authorize this device</p>
                <ol className="ml-4 list-decimal space-y-1.5 text-muted-foreground">
                  <li>
                    Open{" "}
                    <a
                      href={tunnel.loginUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono underline"
                    >
                      {tunnel.loginUrl}
                    </a>
                  </li>
                  <li className="flex items-center gap-2">
                    Enter the code:
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded bg-background px-2 py-0.5 font-mono text-foreground"
                      onClick={() =>
                        navigator.clipboard
                          ?.writeText(tunnel.loginCode ?? "")
                          .then(() => toast.success("Code copied"))
                          .catch(() => {})
                      }
                    >
                      {tunnel.loginCode} <Copy className="size-3" />
                    </button>
                  </li>
                </ol>
                <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="size-3 animate-spin" /> Waiting for
                  authorization…
                </p>
              </div>
            )}

            {/* Connected — only now is the editor URL real and reachable */}
            {tunnel?.connected && tunnel.tunnelUrl && (
              <div className="space-y-2 rounded-md bg-muted/50 p-3 text-sm">
                <p className="font-medium text-foreground">Tunnel connected</p>
                <div className="space-y-1.5 text-muted-foreground">
                  <p>
                    <span className="text-foreground">In the browser:</span>{" "}
                    <a
                      href={tunnel.tunnelUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 font-medium underline"
                    >
                      <ExternalLink className="size-3.5" />
                      {tunnel.tunnelUrl.replace(/^https?:\/\//, "")}
                    </a>
                  </p>
                  <p>
                    <span className="text-foreground">
                      In the desktop app:
                    </span>{" "}
                    install the{" "}
                    <span className="font-medium text-foreground">
                      Remote&nbsp;-&nbsp;Tunnels
                    </span>{" "}
                    extension, then run{" "}
                    <span className="font-mono text-foreground">
                      Remote-Tunnels: Connect to Tunnel
                    </span>{" "}
                    and pick{" "}
                    {(() => {
                      const tn =
                        tunnel.tunnelUrl?.match(/tunnel\/([^/]+)/)?.[1] ?? "";
                      return (
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 rounded bg-background px-1.5 py-0.5 font-mono text-foreground"
                          onClick={() =>
                            navigator.clipboard
                              ?.writeText(tn)
                              .then(() => toast.success("Tunnel name copied"))
                              .catch(() => {})
                          }
                        >
                          {tn} <Copy className="size-3" />
                        </button>
                      );
                    })()}
                  </p>
                  <p className="text-xs">
                    Sign in with the <strong>same account</strong> you authorized
                    the tunnel with. (Or, from the browser tab, run{" "}
                    <span className="font-mono">
                      Continue Working in VS Code Desktop
                    </span>
                    .)
                  </p>
                </div>
              </div>
            )}
            </CardContent>
          </Card>
          </TabsContent>

          {/* Container configuration — base image, port, save */}
          <TabsContent value="container" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">
                Container Configuration
              </CardTitle>
              <CardDescription>
                The base image and port the dev container runs on.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Base image + port */}
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label>Base image</Label>
                  <Select
                    value={imageKind === "custom" ? "custom" : image}
                    onValueChange={(v) => {
                      if (v === "custom") {
                        setImageKind("custom");
                        setImage("");
                      } else {
                        setImageKind("preset");
                        setImage(v);
                      }
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Pick a base image" />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESETS.map((p) => (
                        <SelectItem key={p} value={p}>
                          {p}
                        </SelectItem>
                      ))}
                      <SelectItem value="custom">Custom image…</SelectItem>
                    </SelectContent>
                  </Select>
                  {imageKind === "custom" && (
                    <Input
                      value={image}
                      onChange={(e) => setImage(e.target.value)}
                      placeholder="e.g. node:22-bookworm"
                    />
                  )}
                  <p className="text-xs text-muted-foreground">
                    Runs on official base{" "}
                    <code className="font-mono">{dev.resolvedImage}</code>.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Dev port</Label>
                  <Input
                    type="number"
                    value={port}
                    onChange={(e) => setPort(Number(e.target.value) || 0)}
                  />
                  <p className="text-xs text-muted-foreground">
                    The port your dev server listens on. Defaults to the
                    production port.
                  </p>
                </div>
              </div>

              <div className="space-y-2 rounded-md bg-muted/50 p-3">
                <Label className="text-sm">Running your dev server</Label>
                <p className="text-xs text-muted-foreground">
                  The container does <strong>not</strong> auto-start a dev
                  server — you run it yourself over SSH or the VS Code terminal,
                  so you control when and how it starts. Bind it to the routed
                  port, e.g.:
                </p>
                <code className="block rounded bg-background px-2 py-1 font-mono text-xs">
                  npm run dev -- --host 0.0.0.0 --port $PORT
                </code>
                <p className="text-xs text-muted-foreground">
                  <span className="font-mono">$PORT</span> and{" "}
                  <span className="font-mono">$DEPLO_DEV_PREVIEW_HOST</span> are
                  preset in the shell. For Vite/Astro add{" "}
                  <span className="font-mono">
                    --allowed-hosts $DEPLO_DEV_PREVIEW_HOST
                  </span>{" "}
                  so the preview URL isn&apos;t blocked.
                </p>
              </div>
            </CardContent>
            <CardFooter className="justify-end border-t border-border pt-4">
              <Button size="sm" onClick={saveContainerConfig} disabled={pending}>
                <Save className="size-4" />
                Save container settings
              </Button>
            </CardFooter>
          </Card>
          </TabsContent>

          {/* Preview & environment */}
          <TabsContent value="preview" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Preview &amp; Environment</CardTitle>
              <CardDescription>
                How the dev app is routed publicly and which env vars it
                inherits.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Preview route */}
              <div className="flex items-center justify-between rounded-md border border-border p-3">
                <div className="space-y-1">
                  <Label className="text-sm">Preview URL</Label>
                  <p className="text-xs text-muted-foreground">
                    {previewEnabled ? (
                      <a
                        href={dev.previewUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono underline"
                      >
                        {dev.previewUrl}
                      </a>
                    ) : (
                      "Off — the dev app is not publicly routed."
                    )}
                  </p>
                </div>
                <Switch
                  checked={previewEnabled}
                  onCheckedChange={setPreviewEnabled}
                  disabled={pending}
                />
              </div>

              {/* Env cliff note */}
              <p className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
                <strong>Heads up:</strong> the dev container inherits only env
                entries tagged <code className="font-mono">development</code> —
                its own <code className="font-mono">development</code> vars plus
                any attached shared group that targets{" "}
                <code className="font-mono">development</code>. Production and
                preview-only entries are not included.
              </p>
            </CardContent>
            <CardFooter className="justify-end border-t border-border pt-4">
              <Button size="sm" onClick={savePreview} disabled={pending}>
                <Save className="size-4" />
                Save preview settings
              </Button>
            </CardFooter>
          </Card>
          </TabsContent>

          {/* SSH access */}
          <TabsContent value="ssh" className="mt-0">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Terminal className="size-4" /> SSH Access
              </CardTitle>
              <CardDescription>
                Each user reaches only this project&apos;s dev container,
                landing as <code className="font-mono">devuser</code> in{" "}
                <code className="font-mono">/workspace</code>. A key is the
                default; a password is an opt-in. All users share one host and
                port: <code className="font-mono">{host}:2222</code>.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {users.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Username</TableHead>
                      <TableHead>Auth</TableHead>
                      <TableHead>Connect</TableHead>
                      <TableHead className="w-10" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.map((u) => {
                      const cmd = `ssh ${u.username}@${host} -p 2222`;
                      return (
                        <TableRow key={u.id}>
                          <TableCell className="font-mono">
                            {u.username}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-1">
                              {u.publicKey && (
                                <Badge variant="outline" className="gap-1">
                                  <KeyRound className="size-3" /> key
                                </Badge>
                              )}
                              {u.hasPassword && (
                                <Badge variant="outline">password</Badge>
                              )}
                            </div>
                          </TableCell>
                          <TableCell>
                            <button
                              type="button"
                              className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground"
                              onClick={() => {
                                navigator.clipboard
                                  ?.writeText(cmd)
                                  .then(() => toast.success("Copied"))
                                  .catch(() => {});
                              }}
                            >
                              <Copy className="size-3" /> {cmd}
                            </button>
                          </TableCell>
                          <TableCell>
                            <ConfirmAction
                              trigger={
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="size-8"
                                >
                                  <Trash2 className="size-4" />
                                </Button>
                              }
                              title={`Remove ${u.username}?`}
                              description="Their SSH access is revoked immediately. This cannot be undone."
                              confirmLabel="Remove user"
                              onConfirm={() => removeUser(u.id, u.username)}
                            />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              )}

              {/* Add user */}
              <div className="space-y-3 rounded-md border border-border p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Username</Label>
                    <Input
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="alice"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      Password{" "}
                      <span className="text-muted-foreground">(opt-in)</span>
                    </Label>
                    <Input
                      type="password"
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder="leave blank for key-only"
                    />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    SSH public key{" "}
                    <span className="text-muted-foreground">(recommended)</span>
                  </Label>
                  <Textarea
                    value={newKey}
                    onChange={(e) => setNewKey(e.target.value)}
                    placeholder="ssh-ed25519 AAAA… user@host"
                    className="font-mono text-xs"
                    rows={2}
                  />
                </div>
                <div className="flex justify-end">
                  <Button size="sm" onClick={addUser} disabled={pending}>
                    <Plus className="size-4" />
                    Add SSH user
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
