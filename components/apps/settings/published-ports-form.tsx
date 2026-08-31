"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Cable, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import {
  MAX_PORT,
  MIN_USER_PORT,
  isValidExposePort,
} from "@/lib/databases/ports";
import { MAX_PUBLISHED_PORTS, type PublishedPort } from "@/lib/types";

/**
 * Host ports one app publishes, for what Traefik cannot route - a game server,
 * an SMTP relay, a database the app exposes.
 */

const SAVE = /* GraphQL */ `
  mutation ($id: String!, $ports: [PublishedPortInput!]!) {
    setAppPorts(id: $id, ports: $ports) {
      id
    }
  }
`;

type Row = { id: string; published: string; target: string; protocol: string };

function toRows(ports: PublishedPort[]): Row[] {
  return ports.map((p) => ({
    id: p.id,
    published: String(p.published),
    target: String(p.target),
    protocol: p.protocol,
  }));
}

/** What is wrong with the set, in the words the server would use. */
function problemOf(rows: Row[]): string | null {
  const seen = new Set<string>();
  for (const r of rows) {
    const published = Number(r.published);
    const target = Number(r.target);
    if (!isValidExposePort(published))
      return `A published port must be between ${MIN_USER_PORT} and ${MAX_PORT}.`;
    if (!Number.isInteger(target) || target < 1 || target > MAX_PORT)
      return "The container port must be between 1 and 65535.";
    const key = `${published}/${r.protocol}`;
    if (seen.has(key)) return `This app publishes ${published} twice.`;
    seen.add(key);
  }
  return null;
}

export function PublishedPortsForm({
  appId,
  ports,
  canExposePorts,
}: {
  appId: string;
  ports: PublishedPort[];
  /** COSMETIC: the real gate is `requireExposePorts()` inside `setAppPorts`. */
  canExposePorts: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [rows, setRows] = React.useState<Row[]>(() => toRows(ports));

  const problem = problemOf(rows);
  const full = rows.length >= MAX_PUBLISHED_PORTS;

  function save() {
    if (problem) {
      toast.error(problem);
      return;
    }
    startTransition(async () => {
      const res = await gqlAction(SAVE, {
        id: appId,
        ports: rows.map((r) => ({
          id: r.id,
          published: Number(r.published),
          target: Number(r.target),
          protocol: r.protocol,
        })),
      });
      if (res.ok) {
        toast.success(rows.length ? "Ports saved" : "No ports are published");
        router.refresh();
      } else toast.error(res.error);
    });
  }

  const addButton = (
    <Button
      type="button"
      variant="outline"
      disabled={pending || !canExposePorts || full}
      onClick={() =>
        setRows((r) => [
          ...r,
          {
            id: `prt_${Math.random().toString(36).slice(2, 10)}`,
            published: "",
            target: "",
            protocol: "tcp",
          },
        ])
      }
    >
      Add port
    </Button>
  );

  return (
    <div id="published-ports" className="scroll-mt-20 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-56 flex-1">
          <p className="flex items-center gap-2 text-sm font-medium">
            <Cable className="size-4 text-muted-foreground" />
            Published ports
            <InfoTip
              content="A port of the server bound straight to a port of the container. No certificate and no proxy: use a domain whenever the app speaks HTTP."
              docs="ports.published"
            />
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Reach this app on a port of the server, for anything that is not a
            website.
          </p>
        </div>
        {canExposePorts ? (
          addButton
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{addButton}</span>
            </TooltipTrigger>
            <TooltipContent>
              You don&apos;t have permission to publish ports
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {rows.length > 0 && (
        <form
          className="mt-4 grid gap-3 border-t pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {rows.map((row, i) => (
            <div key={row.id} className="flex items-end gap-2">
              <div className="grid flex-1 gap-2">
                {i === 0 && (
                  <label
                    className="text-sm font-medium"
                    htmlFor={`port-published-${row.id}`}
                  >
                    Host port
                  </label>
                )}
                <Input
                  id={`port-published-${row.id}`}
                  inputMode="numeric"
                  value={row.published}
                  placeholder="e.g. 16379"
                  disabled={pending || !canExposePorts}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((r) =>
                        r.id === row.id
                          ? {
                              ...r,
                              published: e.target.value.replace(/[^0-9]/g, ""),
                            }
                          : r,
                      ),
                    )
                  }
                />
              </div>
              <div className="grid flex-1 gap-2">
                {i === 0 && (
                  <label
                    className="text-sm font-medium"
                    htmlFor={`port-target-${row.id}`}
                  >
                    Container port
                  </label>
                )}
                <Input
                  id={`port-target-${row.id}`}
                  inputMode="numeric"
                  value={row.target}
                  placeholder="e.g. 6379"
                  disabled={pending || !canExposePorts}
                  onChange={(e) =>
                    setRows((rs) =>
                      rs.map((r) =>
                        r.id === row.id
                          ? {
                              ...r,
                              target: e.target.value.replace(/[^0-9]/g, ""),
                            }
                          : r,
                      ),
                    )
                  }
                />
              </div>
              <div className="grid w-28 gap-2">
                {i === 0 && (
                  <span className="text-sm font-medium">Protocol</span>
                )}
                <Select
                  value={row.protocol}
                  disabled={pending || !canExposePorts}
                  onValueChange={(v) =>
                    setRows((rs) =>
                      rs.map((r) =>
                        r.id === row.id ? { ...r, protocol: v } : r,
                      ),
                    )
                  }
                >
                  <SelectTrigger aria-label="Protocol">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="udp">UDP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Remove"
                disabled={pending || !canExposePorts}
                onClick={() =>
                  setRows((rs) => rs.filter((r) => r.id !== row.id))
                }
              >
                <Trash2 className="size-4" />
              </Button>
            </div>
          ))}

          {problem && <p className="text-sm text-destructive">{problem}</p>}

          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              Applied on the next deploy.
            </p>
            <Button
              type="submit"
              disabled={pending || problem != null || !canExposePorts}
            >
              Save
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
