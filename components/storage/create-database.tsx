"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  Plus,
  Database as DatabaseIcon,
  Leaf,
  MemoryStick,
  BarChart3,
  type LucideIcon,
} from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useRouter } from "next/navigation";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseType } from "@/lib/types";

const TYPES: {
  id: DatabaseType;
  name: string;
  icon: LucideIcon;
  versions: string[];
}[] = [
  { id: "postgres", name: "PostgreSQL", icon: DatabaseIcon, versions: ["16", "15", "14"] },
  { id: "mysql", name: "MySQL", icon: DatabaseIcon, versions: ["8", "5.7"] },
  { id: "mariadb", name: "MariaDB", icon: DatabaseIcon, versions: ["11", "10"] },
  { id: "mongodb", name: "MongoDB", icon: Leaf, versions: ["7", "6"] },
  { id: "redis", name: "Redis", icon: MemoryStick, versions: ["7", "6"] },
  { id: "clickhouse", name: "ClickHouse", icon: BarChart3, versions: ["24", "23"] },
];

export function CreateDatabase() {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState("");
  const [type, setType] = React.useState<DatabaseType>("postgres");
  const [version, setVersion] = React.useState("16");
  const [exposed, setExposed] = React.useState(false);

  const current = TYPES.find((t) => t.id === type)!;

  function onTypeChange(v: string) {
    const t = v as DatabaseType;
    setType(t);
    setVersion(TYPES.find((x) => x.id === t)!.versions[0]);
  }

  function submit() {
    startTransition(async () => {
      const res = await gqlAction<{ createDatabase: { id: string } }, { id: string }>(
        `mutation($input: CreateDatabaseInput!) {
          createDatabase(input: $input) { id }
        }`,
        { input: { name, type, version, exposedPublicly: exposed } },
        (d) => d.createDatabase,
      );
      if (res.ok) {
        toast.success(`Database ${name} is provisioning`);
        setOpen(false);
        setName("");
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
          New Database
        </Button>
      </DialogTrigger>
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
              <Label>Version</Label>
              <Select value={version} onValueChange={setVersion}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {current.versions.map((v) => (
                    <SelectItem key={v} value={v}>
                      {v}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Expose publicly</p>
              <p className="text-xs text-muted-foreground">
                Publish the port to the internet. Keep off unless required.
              </p>
            </div>
            <Switch checked={exposed} onCheckedChange={setExposed} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={pending || !name.trim()}>
            {pending ? "Creating…" : "Create database"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
