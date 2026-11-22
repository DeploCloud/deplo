"use client";

import * as React from "react";
import { toast } from "sonner";
import { Loader2, MapPin, TriangleAlert } from "lucide-react";

import { AdvancedSection } from "@/components/apps/wizard/advanced-section";
import { SettingItem } from "@/components/settings/deplo-settings-panel/setting-item";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FieldLabel } from "@/components/ui/info-tip";
import { Input } from "@/components/ui/input";
import { gql, gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { useRouter } from "@/lib/nav";
import type {
  ClusterDnsView,
  ClusterServerPlace,
} from "@/lib/types/cluster-dns";

// Where each server of a cluster is (ADR-0049 phase 2): https://deplo.build/docs/operations/clusters/dns-zone#nearest-servers-first

type CityHit = { label: string; latitude: number; longitude: number };

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

const SEARCH_CITIES = /* GraphQL */ `
  query SearchCities($query: String!) {
    searchCities(query: $query) {
      label
      latitude
      longitude
    }
  }
`;

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
export function ServerPlaces({ dns }: { dns: ClusterDnsView }) {
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
