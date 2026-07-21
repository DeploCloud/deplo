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
import { FieldLabel } from "@/components/ui/info-tip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "next/navigation";
import { gqlAction } from "@/lib/graphql-client";
import type { S3Provider } from "@/lib/types";

// Inlined (lib/data/s3 is server-only and cannot be imported on the client).
const PROVIDERS: { id: S3Provider; name: string; endpointHint: string }[] = [
  { id: "aws", name: "Amazon S3", endpointHint: "https://s3.us-east-1.amazonaws.com" },
  { id: "cloudflare-r2", name: "Cloudflare R2", endpointHint: "https://<account>.r2.cloudflarestorage.com" },
  { id: "backblaze-b2", name: "Backblaze B2", endpointHint: "https://s3.us-west-001.backblazeb2.com" },
  { id: "digitalocean", name: "DigitalOcean Spaces", endpointHint: "https://fra1.digitaloceanspaces.com" },
  { id: "wasabi", name: "Wasabi", endpointHint: "https://s3.eu-central-1.wasabisys.com" },
  { id: "minio", name: "MinIO (self-hosted)", endpointHint: "https://minio.example.com" },
  { id: "other", name: "Other S3-compatible", endpointHint: "https://..." },
];

export function CreateS3({ autoOpen = false }: { autoOpen?: boolean } = {}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(autoOpen);
  const [pending, startTransition] = React.useTransition();

  // Arrived via ?new=s3 (e.g. the global "New ▸ S3 destination" menu) → drop the
  // param so a refresh or Back doesn't reopen the dialog. Mirrors CreateDatabase.
  React.useEffect(() => {
    if (autoOpen) router.replace("/storage", { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [provider, setProvider] = React.useState<S3Provider>("cloudflare-r2");
  const [form, setForm] = React.useState({
    name: "",
    endpoint: "",
    region: "auto",
    bucket: "",
    accessKey: "",
    secretKey: "",
  });

  const hint = PROVIDERS.find((p) => p.id === provider)!.endpointHint;
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    submit();
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($input: CreateS3Input!) { createS3(input: $input) { id } }`,
        {
          input: {
            name: form.name,
            provider: provider.toUpperCase().replace(/-/g, "_"),
            endpoint: form.endpoint || hint,
            region: form.region,
            bucket: form.bucket,
            accessKey: form.accessKey,
            secretKey: form.secretKey,
          },
        },
      );
      if (res.ok) {
        toast.success("S3 destination connected");
        setOpen(false);
        setForm({ name: "", endpoint: "", region: "auto", bucket: "", accessKey: "", secretKey: "" });
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Add S3 Destination
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Add S3 destination</DialogTitle>
          <DialogDescription>
            Connect any S3-compatible bucket for backups and asset storage.
            Credentials are encrypted at rest.
          </DialogDescription>
        </DialogHeader>
        <form className="grid gap-4" onSubmit={onSubmit}>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>Name</Label>
                <Input value={form.name} onChange={set("name")} placeholder="Backups bucket" />
              </div>
              <div className="space-y-2">
                <FieldLabel info="Picks the S3-compatible service. Choosing one pre-fills the matching endpoint format below.">Provider</FieldLabel>
                <Select value={provider} onValueChange={(v) => setProvider(v as S3Provider)}>
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
            </div>
            <div className="space-y-2">
              <FieldLabel info="The S3 API URL for your bucket. Leave blank to use the default endpoint for the selected provider.">Endpoint</FieldLabel>
              <Input
                value={form.endpoint}
                onChange={set("endpoint")}
                placeholder={hint}
                className="font-mono text-xs"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <FieldLabel info={<>The bucket&apos;s region. Use <code className="font-mono">auto</code> for providers like Cloudflare R2 that don&apos;t require a specific region.</>}>Region</FieldLabel>
                <Input value={form.region} onChange={set("region")} placeholder="auto" />
              </div>
              <div className="space-y-2">
                <Label>Bucket</Label>
                <Input value={form.bucket} onChange={set("bucket")} placeholder="my-bucket" />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Access Key ID</Label>
              <Input
                value={form.accessKey}
                onChange={set("accessKey")}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label>Secret Access Key</Label>
              <Input
                type="password"
                value={form.secretKey}
                onChange={set("secretKey")}
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Connecting…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
