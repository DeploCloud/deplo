import { builder } from "../builder";
import {
  checkDnsProvider,
  dnsProviderTeamChoices,
  listMyDnsProviders,
  removeDnsProvider,
  saveDnsProvider,
  updateDnsProvider,
  type DnsProviderCheck,
  type DnsProviderTeam,
  type DnsProviderView,
} from "@/lib/data/dns-providers/store";
import {
  autoDnsZones,
  type AutoDnsZone,
} from "@/lib/data/dns-providers/provision";

const DnsProviderKindEnum = builder.enumType("DnsProviderKind", {
  values: ["cloudflare"] as const,
});

const DnsProviderTeamRef = builder
  .objectRef<DnsProviderTeam>("DnsProviderTeam")
  .implement({
    fields: (t) => ({
      id: t.exposeID("id"),
      name: t.exposeString("name"),
      slug: t.exposeString("slug"),
    }),
  });

const DnsProviderRef = builder
  .objectRef<DnsProviderView>("DnsProvider")
  .implement({
    description:
      "A DNS provider account the caller connected for automatic DNS. Its API " +
      "token belongs to the caller and is never returned.",
    fields: (t) => ({
      id: t.exposeID("id"),
      provider: t.field({
        type: DnsProviderKindEnum,
        resolve: (p) => p.provider,
      }),
      zoneName: t.exposeString("zoneName", {
        description: "The domain whose names get their DNS made for them.",
      }),
      shared: t.exposeBoolean("shared", {
        description:
          "Whether every member of its teams may use it, not only the caller.",
      }),
      teams: t.field({ type: [DnsProviderTeamRef], resolve: (p) => p.teams }),
      createdAt: t.exposeString("createdAt"),
    }),
  });

const DnsProviderCheckRef = builder
  .objectRef<DnsProviderCheck>("DnsProviderCheck")
  .implement({
    fields: (t) => ({
      zoneName: t.exposeString("zoneName"),
      tunnels: t.exposeBoolean("tunnels", {
        description: "Whether the token may also create Cloudflare Tunnels.",
      }),
    }),
  });

const AutoDnsZoneRef = builder.objectRef<AutoDnsZone>("AutoDnsZone").implement({
  fields: (t) => ({
    zoneName: t.exposeString("zoneName"),
    provider: t.field({
      type: DnsProviderKindEnum,
      resolve: (z) => z.provider,
    }),
  }),
});

builder.queryFields((t) => ({
  dnsProviders: t.field({
    type: [DnsProviderRef],
    authScopes: { loggedIn: true },
    description: "The DNS provider accounts the caller connected.",
    resolve: () => listMyDnsProviders(),
  }),
  dnsProviderTeamChoices: t.field({
    type: [DnsProviderTeamRef],
    authScopes: { loggedIn: true },
    description:
      "The teams the caller may connect a DNS provider to: where they hold `manage_domains`.",
    resolve: () => dnsProviderTeamChoices(),
  }),
  autoDnsZones: t.field({
    type: [AutoDnsZoneRef],
    authScopes: { loggedIn: true },
    description:
      "Domains whose names get their DNS created automatically when the caller " +
      "adds them in the active team: their own, and ones shared with the team.",
    resolve: () => autoDnsZones(),
  }),
}));

builder.mutationFields((t) => ({
  checkDnsProvider: t.field({
    type: DnsProviderCheckRef,
    authScopes: { loggedIn: true },
    description:
      "Check that an API token reaches this domain at the provider, without saving anything.",
    args: {
      provider: t.arg({ type: DnsProviderKindEnum, required: true }),
      zone: t.arg.string({ required: true }),
      apiToken: t.arg.string({ required: true }),
    },
    resolve: (_r, args) => checkDnsProvider(args),
  }),
  saveDnsProvider: t.field({
    type: DnsProviderRef,
    authScopes: { loggedIn: true },
    description:
      "Connect a domain for automatic DNS in the given teams, or replace the " +
      "token of one the caller already connected.",
    args: {
      provider: t.arg({ type: DnsProviderKindEnum, required: true }),
      zone: t.arg.string({ required: true }),
      apiToken: t.arg.string({ required: true }),
      teamIds: t.arg.stringList({ required: true }),
      shared: t.arg.boolean({ required: true }),
    },
    resolve: (_r, args) => saveDnsProvider(args),
  }),
  updateDnsProvider: t.field({
    type: DnsProviderRef,
    authScopes: { loggedIn: true },
    description:
      "Change which teams may use a connected domain, and who in them.",
    args: {
      id: t.arg.string({ required: true }),
      teamIds: t.arg.stringList({ required: true }),
      shared: t.arg.boolean({ required: true }),
    },
    resolve: (_r, args) => updateDnsProvider(args),
  }),
  removeDnsProvider: t.field({
    type: "String",
    nullable: true,
    authScopes: { loggedIn: true },
    description:
      "Disconnect a domain from automatic DNS. Its Cloudflare Tunnels are torn " +
      "down; returns what Deplo could not clean up, or null.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => removeDnsProvider(id),
  }),
}));
