"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  CircleCheck,
  Globe,
  Loader2,
  MapPin,
  Timer,
  Trash2,
  TriangleAlert,
} from "lucide-react";

import { AdvancedSection } from "@/components/apps/wizard/advanced-section";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { ConfirmAction } from "@/components/shared/confirm-action";
import { CopyButton } from "@/components/shared/copy-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DocsLink } from "@/components/ui/docs-link";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { gql, gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { useRouter } from "@/lib/nav";
import type {
  ClusterDnsView,
  ClusterServerPlace,
  DelegationCheck,
} from "@/lib/types/cluster-dns";
import { DNS_DROP_AFTER, DNS_TTL } from "@/lib/deploy/cluster-zone";

// A cluster's own DNS zone (ADR-0049): https://deplo.build/docs/operations/clusters/dns-zone

const ADD_ZONE = /* GraphQL */ `
  mutation AddClusterDnsZone($clusterId: String!, $name: String!) {
    addClusterDnsZone(clusterId: $clusterId, name: $name)
  }
`;

const REMOVE_ZONE = /* GraphQL */ `
  mutation RemoveClusterDnsZone($id: String!) {
    removeClusterDnsZone(id: $id)
  }
`;

const SET_TIMES = /* GraphQL */ `
  mutation SetClusterDnsTimes(
    $clusterId: String!
    $answerTtl: Int!
    $dropAfter: Int!
  ) {
    setClusterDnsTimes(
      clusterId: $clusterId
      answerTtl: $answerTtl
      dropAfter: $dropAfter
    )
  }
`;

const CHECK_ZONE = /* GraphQL */ `
  query CheckClusterDnsZone($id: String!) {
    checkClusterDnsZone(id: $id) {
      delegated
      parent
      problems
      nameServers {
        name
        address
        answers
      }
    }
  }
`;

const SEARCH_CITIES = /* GraphQL */ `
  query SearchCities($query: String!) {
    searchCities(query: $query) {
      label
      latitude
      longitude
    }
  }
`;

const SET_PLACE = /* GraphQL */ `
  mutation SetServerPlace(
    $serverId: String!
    $latitude: Float
    $longitude: Float
    $label: String
  ) {
    setServerPlace(
      serverId: $serverId
      latitude: $latitude
      longitude: $longitude
      label: $label
    )
  }
`;

type CityHit = { label: string; latitude: number; longitude: number };

const ZONE_HINT =
  "The cluster's servers answer for the domain themselves and name only the healthy ones, so no record changes when a server stops.";

const STATE_LABELS: Record<string, string> = {
  answer: "Answers",
  stale: "Hears half the cluster: repeats the last answer",
  fail: "Hears too few servers: answers with an error",
  warming: "Starting",
  unsupported: "Agent too old",
  unreachable: "Not reachable",
};

/** The records to add at the registrar for one zone, and a check that they are there. */
function DelegateDialog({
  zone,
  dns,
  open,
  onOpenChange,
}: {
  zone: ClusterDnsView["zones"][number];
  dns: ClusterDnsView;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [checking, setChecking] = React.useState(false);
  const [check, setCheck] = React.useState<DelegationCheck | null>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    try {
      const r = await gql<{ checkClusterDnsZone: DelegationCheck }>(
        CHECK_ZONE,
        { id: zone.id },
      );
      setCheck(r.checkClusterDnsZone);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setChecking(false);
    }
  };
  const silent = dns.servers.filter((s) => !s.serving);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <form className="grid gap-4" onSubmit={run}>
          <DialogHeader>
            <DialogTitle>Delegate {zone.name}</DialogTitle>
            <DialogDescription>
              Add these records <strong>where you bought the domain</strong>.{" "}
              <DocsLink topic="clusters.dnsZoneDelegate" />
            </DialogDescription>
          </DialogHeader>
          {zone.records.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No server of the cluster answers on port 53 yet, so there is
              nothing to delegate to.
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Value</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {zone.records.map((r) => (
                    <TableRow key={`${r.name}-${r.type}-${r.value}`}>
                      <TableCell className="font-mono text-xs">
                        {r.name}
                        <CopyButton value={r.name} className="ml-1 size-6" />
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.type}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.value}
                        <CopyButton value={r.value} className="ml-1 size-6" />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          {silent.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {silent.map((s) => (
                <li key={s.serverId} className="flex items-start gap-1.5">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warning,#d97706)]" />
                  <span>
                    <span className="text-foreground">{s.serverName}</span>{" "}
                    cannot answer:{" "}
                    {s.problem || STATE_LABELS[s.state] || s.state}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {check && (
            <div className="space-y-1.5 text-sm">
              {check.delegated ? (
                <p className="flex items-center gap-1.5">
                  <CircleCheck className="size-4 text-success" />
                  {zone.name} is delegated to the cluster.
                </p>
              ) : (
                <ul className="space-y-1">
                  {check.problems.map((p) => (
                    <li key={p} className="flex items-start gap-1.5">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning,#d97706)]" />
                      <span>{p}</span>
                    </li>
                  ))}
                </ul>
              )}
              {check.nameServers
                .filter((n) => !n.answers)
                .map((n) => (
                  <p
                    key={n.name}
                    className="flex items-start gap-1.5 text-muted-foreground"
                  >
                    <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warning,#d97706)]" />
                    {n.name} ({n.address}) did not answer Deplo. Port 53 must be
                    open on that server.
                  </p>
                ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Close
            </Button>
            <Button
              type="submit"
              disabled={checking || zone.records.length === 0}
            >
              {checking && <Loader2 className="size-4 animate-spin" />}
              Check
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ZoneRow({
  zone,
  dns,
}: {
  zone: ClusterDnsView["zones"][number];
  dns: ClusterDnsView;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="min-w-0 flex-1 truncate font-mono text-sm">
        {zone.name}
      </span>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Records
      </Button>
      <ConfirmAction
        trigger={
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Remove ${zone.name}`}
          >
            <Trash2 className="size-4" />
          </Button>
        }
        title={`Remove ${zone.name}?`}
        description="The cluster stops answering for this zone."
        consequence={
          zone.names.length > 0
            ? `${zone.names.length === 1 ? "A domain" : `${zone.names.length} domains`} answered by it stop resolving until their records point at the servers again.`
            : undefined
        }
        confirmLabel="Remove"
        successMessage={`Removed ${zone.name}`}
        onConfirm={async () => {
          const res = await gqlAction(REMOVE_ZONE, { id: zone.id });
          if (res.ok) router.refresh();
          return res;
        }}
      />
      <DelegateDialog
        zone={zone}
        dns={dns}
        open={open}
        onOpenChange={setOpen}
      />
    </div>
  );
}

function TimesForm({
  clusterId,
  dns,
}: {
  clusterId: string;
  dns: ClusterDnsView;
}) {
  const router = useRouter();
  const [ttl, setTtl] = React.useState(String(dns.answerTtl));
  const [drop, setDrop] = React.useState(String(dns.dropAfter));
  const [pending, startTransition] = React.useTransition();
  const changed =
    ttl !== String(dns.answerTtl) || drop !== String(dns.dropAfter);
  const save = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(SET_TIMES, {
        clusterId,
        answerTtl: Number(ttl),
        dropAfter: Number(drop),
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success("Saved the DNS times");
      router.refresh();
    });
  };
  return (
    <form className="flex flex-wrap items-end gap-3" onSubmit={save}>
      <div className="grid gap-1.5">
        <FieldLabel
          htmlFor={`dns-ttl-${clusterId}`}
          info="How long resolvers keep an answer: longer means fewer queries, and a stopped server named for longer."
        >
          Answers last (s)
        </FieldLabel>
        <Input
          id={`dns-ttl-${clusterId}`}
          type="number"
          min={DNS_TTL.min}
          max={DNS_TTL.max}
          value={ttl}
          onChange={(e) => setTtl(e.target.value)}
          className="w-32"
          disabled={pending}
        />
      </div>
      <div className="grid gap-1.5">
        <FieldLabel
          htmlFor={`dns-drop-${clusterId}`}
          info="How long a server unheard on the private network stays in the answers."
        >
          Stopped server leaves after (s)
        </FieldLabel>
        <Input
          id={`dns-drop-${clusterId}`}
          type="number"
          min={DNS_DROP_AFTER.min}
          max={DNS_DROP_AFTER.max}
          value={drop}
          onChange={(e) => setDrop(e.target.value)}
          className="w-32"
          disabled={pending}
        />
      </div>
      <Button type="submit" disabled={pending || !changed}>
        Save
      </Button>
    </form>
  );
}

/** Where one server is: a city found by name, or coordinates behind Advanced, or back to its address. */
function PlaceDialog({
  server,
  open,
  onOpenChange,
}: {
  server: ClusterServerPlace;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const was = {
    lat: String(server.place?.latitude ?? ""),
    lon: String(server.place?.longitude ?? ""),
  };
  const [query, setQuery] = React.useState("");
  const [hits, setHits] = React.useState<CityHit[]>([]);
  const [picked, setPicked] = React.useState<CityHit | null>(null);
  const [lat, setLat] = React.useState(was.lat);
  const [lon, setLon] = React.useState(was.lon);
  const [pending, startTransition] = React.useTransition();
  const q = query.trim();
  React.useEffect(() => {
    if (q.length < 2) return;
    const t = setTimeout(() => {
      gql<{ searchCities: CityHit[] }>(SEARCH_CITIES, { query: q }).then(
        (r) => setHits(r.searchCities),
        () => setHits([]),
      );
    }, 200);
    return () => clearTimeout(t);
  }, [q]);
  const shown = q.length < 2 ? [] : hits;
  const typed =
    !picked &&
    (lat !== was.lat || lon !== was.lon) &&
    lat.trim() !== "" &&
    lon.trim() !== "";
  const save = (place: {
    latitude?: number;
    longitude?: number;
    label?: string;
  }) =>
    startTransition(async () => {
      const res = await gqlAction(SET_PLACE, {
        serverId: server.serverId,
        ...place,
      });
      if (!res.ok) return void toast.error(res.error);
      toast.success(`Saved where ${server.serverName} is`);
      onOpenChange(false);
      router.refresh();
    });
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (picked)
      save({
        latitude: picked.latitude,
        longitude: picked.longitude,
        label: picked.label,
      });
    else if (typed) save({ latitude: Number(lat), longitude: Number(lon) });
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Where is {server.serverName}?</DialogTitle>
            <DialogDescription>
              Visitors are answered with{" "}
              <strong>the servers nearest them</strong>.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <FieldLabel htmlFor={`place-${server.serverId}`}>City</FieldLabel>
            <Input
              id={`place-${server.serverId}`}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setPicked(null);
              }}
              placeholder={server.place?.label ?? "Frankfurt"}
              autoComplete="off"
              disabled={pending}
            />
            {shown.length > 0 && (
              <ul className="overflow-hidden rounded-lg border border-border bg-card">
                {shown.map((h) => (
                  <li key={`${h.label}-${h.latitude}-${h.longitude}`}>
                    <button
                      type="button"
                      onClick={() => setPicked(h)}
                      aria-pressed={picked === h}
                      className={cn(
                        "flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-sm hover:bg-surface",
                        picked === h && "bg-primary-wash",
                      )}
                    >
                      <MapPin className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate">{h.label}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <AdvancedSection>
            <div className="flex flex-wrap gap-3">
              <div className="grid gap-1.5">
                <FieldLabel
                  htmlFor={`lat-${server.serverId}`}
                  info="Degrees from -90 to 90; north is positive."
                >
                  Latitude
                </FieldLabel>
                <Input
                  id={`lat-${server.serverId}`}
                  inputMode="decimal"
                  value={lat}
                  onChange={(e) => {
                    setLat(e.target.value);
                    setPicked(null);
                  }}
                  className="w-36"
                  disabled={pending}
                />
              </div>
              <div className="grid gap-1.5">
                <FieldLabel
                  htmlFor={`lon-${server.serverId}`}
                  info="Degrees from -180 to 180; east is positive."
                >
                  Longitude
                </FieldLabel>
                <Input
                  id={`lon-${server.serverId}`}
                  inputMode="decimal"
                  value={lon}
                  onChange={(e) => {
                    setLon(e.target.value);
                    setPicked(null);
                  }}
                  className="w-36"
                  disabled={pending}
                />
              </div>
            </div>
          </AdvancedSection>
          <DialogFooter>
            {server.place && server.place.source !== "address" && (
              <Button
                variant="ghost"
                disabled={pending}
                onClick={() => save({})}
              >
                Use its address
              </Button>
            )}
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || (!picked && !typed)}>
              {pending && <Loader2 className="size-4 animate-spin" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function PlaceRow({ server }: { server: ClusterServerPlace }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="flex items-center gap-2">
      <span className="w-32 shrink-0 truncate text-sm">
        {server.serverName}
      </span>
      <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
        {server.place
          ? `${server.place.label}${server.place.source === "address" ? " · from its address" : ""}`
          : "Not placed"}
      </span>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        Change
      </Button>
      <PlaceDialog server={server} open={open} onOpenChange={setOpen} />
    </div>
  );
}

const MONTH = new Intl.DateTimeFormat("en", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** Where each server is, and the location table visitors are placed with, credited to DB-IP as its licence asks. */
function ServerPlaces({ dns }: { dns: ClusterDnsView }) {
  const unplaced = dns.places.filter((p) => !p.place);
  const behind = dns.servers.filter(
    (s) => s.serving && !s.nearest && unplaced.length === 0,
  );
  const { geo } = dns;
  return (
    <SettingItem
      icon={MapPin}
      title="Server locations"
      info="Each visitor is answered with the healthy servers nearest it, always at least two when two are up."
      docs="clusters.dnsZoneNearest"
    >
      <div className="space-y-3">
        {dns.places.map((p) => (
          <PlaceRow key={p.serverId} server={p} />
        ))}
        {geo.state === "ready" && unplaced.length > 0 && (
          <p className="text-xs text-muted-foreground">
            Place every server to answer each visitor with the nearest ones.
          </p>
        )}
        {geo.state === "ready" && behind.length > 0 && (
          <p className="text-xs text-muted-foreground">
            {behind.map((s) => s.serverName).join(", ")} answer every healthy
            server until {behind.length === 1 ? "its" : "their"} server agent
            updates.
          </p>
        )}
        <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          {geo.state === "ready" && geo.release ? (
            <>
              <a
                href="https://db-ip.com"
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-foreground"
              >
                IP geolocation by DB-IP
              </a>
              <span>
                · location table of{" "}
                {MONTH.format(new Date(`${geo.release}-01T00:00:00Z`))}
              </span>
              {geo.stale && (
                <span className="inline-flex items-center gap-1">
                  <TriangleAlert className="size-3.5 text-[var(--warning,#d97706)]" />
                  Over three months old: update Deplo for a newer one.
                </span>
              )}
            </>
          ) : geo.state === "damaged" ? (
            <span className="inline-flex items-center gap-1">
              <TriangleAlert className="size-3.5 text-[var(--warning,#d97706)]" />
              This build&apos;s location table is damaged, so every healthy
              server is answered.
            </span>
          ) : (
            <span>
              This build carries no location table, so every healthy server is
              answered.
            </span>
          )}
        </p>
      </div>
    </SettingItem>
  );
}

/** The cluster's own DNS zones: add one, see what to add at the registrar, and the two times behind Advanced. */
export function ClusterDnsRow({
  cluster,
  dns,
}: {
  cluster: { id: string; name: string };
  dns: ClusterDnsView;
}) {
  const router = useRouter();
  const [name, setName] = React.useState("");
  const [pending, startTransition] = React.useTransition();
  const add = (e: React.FormEvent) => {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(ADD_ZONE, { clusterId: cluster.id, name });
      if (!res.ok) return void toast.error(res.error);
      toast.success(
        `${cluster.name} answers for ${name.trim().toLowerCase()} once it is delegated`,
      );
      setName("");
      router.refresh();
    });
  };
  return (
    <>
      <SettingItem
        icon={Globe}
        title="DNS zone"
        info={ZONE_HINT}
        docs="clusters.dnsZone"
        description="Let the servers answer for a domain you delegate to them."
      >
        <div className="space-y-3">
          {dns.zones.map((z) => (
            <ZoneRow key={z.id} zone={z} dns={dns} />
          ))}
          <form className="flex flex-wrap items-center gap-2" onSubmit={add}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="go.example.com"
              aria-label="Zone"
              className="min-w-0 flex-1"
              disabled={pending}
            />
            <Button type="submit" disabled={pending || name.trim() === ""}>
              Add
            </Button>
          </form>
          {dns.zones.length > 0 && (
            <AdvancedSection
              summary={
                <span className="inline-flex items-center gap-1">
                  <Timer className="size-3.5" />
                  {dns.answerTtl} s · {dns.dropAfter} s
                </span>
              }
            >
              <TimesForm clusterId={cluster.id} dns={dns} />
            </AdvancedSection>
          )}
        </div>
      </SettingItem>
      {dns.zones.length > 0 && <ServerPlaces dns={dns} />}
    </>
  );
}
