import { builder } from "../../builder";
import {
  serverHostInfo,
  setServerTimezone,
  restartServerWorkloads,
  restartServerTraefik,
  restartDeploPanel,
  type ServerHostInfo,
  type ServerRestartReport,
  type RestartedWorkload,
} from "@/lib/data/server-maintenance";

const ServerHostInfoRef = builder
  .objectRef<ServerHostInfo>("ServerHostInfo")
  .implement({
    description:
      "What a server IS (its hardware, OS and clock) read live from its agent and stored nowhere. Distinct from the usage gauges on Monitoring: this is the make and model, not the load.",
    fields: (t) => ({
      cpuModel: t.exposeString("cpuModel", {
        description:
          'The processor as it names itself, e.g. "AMD Ryzen 5 5600X 6-Core Processor". Empty when the host does not report one.',
      }),
      cpuCores: t.exposeInt("cpuCores", {
        description:
          "PHYSICAL cores. A 6-core/12-thread chip reports 6 here and 12 in cpuThreads; reporting threads as cores is the usual way a spec sheet overstates a box.",
      }),
      cpuThreads: t.exposeInt("cpuThreads", {
        description: "Logical processors - what schedulers and `nproc` count.",
      }),
      memTotalBytes: t.exposeFloat("memTotalBytes", {
        description: "Installed RAM, in bytes.",
      }),
      diskTotalBytes: t.exposeFloat("diskTotalBytes", {
        description:
          "Size of the filesystem the agent's data lives on, in bytes.",
      }),
      diskUsedBytes: t.exposeFloat("diskUsedBytes", {
        description: "Used bytes on that filesystem.",
      }),
      osPretty: t.exposeString("osPretty", {
        description: 'The distribution, e.g. "Ubuntu 24.04.1 LTS".',
      }),
      kernel: t.exposeString("kernel", {
        description: "Kernel release (uname -r).",
      }),
      arch: t.exposeString("arch", {
        description: 'Machine architecture, e.g. "x86_64".',
      }),
      dockerVersion: t.exposeString("dockerVersion", {
        description:
          "Docker engine version, empty when the daemon is unreachable.",
      }),
      dockerRootDir: t.exposeString("dockerRootDir", {
        description:
          "Where Docker actually keeps images and volumes - on a host with a mounted data disk this is not the root filesystem.",
      }),
      uptimeSec: t.exposeFloat("uptimeSec", {
        description: "Seconds since the host booted.",
      }),
      timezone: t.exposeString("timezone", {
        description:
          'The host clock\'s IANA zone, e.g. "Europe/Rome". Empty if it reports none.',
      }),
      timeUnixMs: t.exposeFloat("timeUnixMs", {
        description:
          "The host's own clock at the moment of the read (epoch ms). Compare it with controlPlaneTimeUnixMs, never with the viewer's clock, to spot a drifting box.",
      }),
      controlPlaneTimeUnixMs: t.exposeFloat("controlPlaneTimeUnixMs", {
        description:
          "Deplo's own clock when this reading landed (epoch ms). The pair with timeUnixMs is the honest drift measurement: measuring against the browser measures the browser, and a viewer whose laptop is an hour out would see the whole fleet reported as drifting.",
      }),
      utcOffsetMinutes: t.exposeInt("utcOffsetMinutes", {
        description:
          "Offset from UTC in MINUTES, not hours - Kathmandu is +345 and Kolkata +330.",
      }),
      canRestartControlPlane: t.exposeBoolean("canRestartControlPlane", {
        description:
          "Whether the Deplo panel runs in a container on this host that the agent could restart. False when Deplo was started some other way, in which case the restart action is not offered.",
      }),
    }),
  });

const RestartedWorkloadRef = builder
  .objectRef<RestartedWorkload>("RestartedWorkload")
  .implement({
    description: "One workload that could not be restarted, and why.",
    fields: (t) => ({
      kind: t.exposeString("kind", { description: '"app" or "database".' }),
      name: t.exposeString("name"),
      error: t.string({
        nullable: true,
        description: "The failure, verbatim from the host.",
        resolve: (w) => w.error,
      }),
    }),
  });

const ServerRestartReportRef = builder
  .objectRef<ServerRestartReport>("ServerRestartReport")
  .implement({
    description:
      "The outcome of restarting everything Deplo runs on a server. Partial success is normal and is reported as such - one wedged stack must not hide that the other twenty came back.",
    fields: (t) => ({
      restarted: t.exposeInt("restarted"),
      skipped: t.exposeInt("skipped", {
        description:
          "Workloads left alone: the ones already stopped (starting them is a different action than restarting them) and the ones with a deploy in flight, which come back on their own.",
      }),
      failures: t.field({
        type: [RestartedWorkloadRef],
        resolve: (r) => r.failures,
      }),
    }),
  });

builder.mutationFields((t) => ({
  // Each takes an opaque serverId resolved through the pinned dial target, never an address.
  checkServerHostInfo: t.field({
    type: ServerHostInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      "Read what this server IS, right now: CPU model and core count, installed RAM, disk, distribution, kernel, architecture, Docker version and data root, uptime, and the host's own clock and timezone. Also reports whether Deplo manages the Traefik here and whether the Deplo panel runs in a container the agent could restart. Persists nothing. Errors clearly when the agent is unreachable or too old for host management.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => serverHostInfo(id),
  }),
  setServerTimezone: t.field({
    type: ServerHostInfoRef,
    authScopes: { instanceAdmin: true },
    description:
      'Set the host clock\'s timezone to an IANA zone name (e.g. "Europe/Rome"). Changes the wall-clock LABEL, not the instant: nothing restarts, and Deplo\'s own schedules (backups, cleanup) stay on UTC. Aliases are accepted and canonicalised ("US/Eastern" is stored as "America/New_York"); a bare UTC offset is not a zone and is refused. Returns a fresh reading of the host, so the moved clock is visible without a second call. The agent rejects a zone the host does not carry.',
    args: {
      id: t.arg.string({ required: true }),
      timezone: t.arg.string({ required: true }),
    },
    resolve: (_r, { id, timezone }) => setServerTimezone(id, timezone),
  }),
  restartServerWorkloads: t.field({
    type: ServerRestartReportRef,
    authScopes: { instanceAdmin: true },
    description:
      "Restart every App and database Deplo runs on this server, one at a time. Containers Deplo did not deploy are never touched. Workloads that are already stopped are skipped rather than started (restarting and starting are different actions), as are workloads with a deploy in flight, which come back on their own. An App whose last deploy FAILED is restarted, not skipped: a failed deploy usually leaves the previous stack serving. Reports per-workload failures instead of stopping at the first one, and says explicitly when a workload stopped but did not start again.",
    args: { id: t.arg.string({ required: true }) },
    resolve: (_r, { id }) => restartServerWorkloads(id),
  }),
  restartServerTraefik: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      "Restart the Traefik reverse proxy on this server. The configuration is untouched - this is the 'it is wedged, bounce it' action. Routing on this host is interrupted for the few seconds Traefik takes to come back. Errors when Deplo did not install Traefik there.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await restartServerTraefik(id);
      return true;
    },
  }),
  restartDeploPanel: t.field({
    type: "Boolean",
    authScopes: { instanceAdmin: true },
    description:
      "Restart the Deplo control plane on the host that runs it. Refused for any other server. Returns once the restart is SCHEDULED, not once it is done: the restart ends the process serving this request, so the answer necessarily arrives first - expect the dashboard to be briefly unreachable.",
    args: { id: t.arg.string({ required: true }) },
    resolve: async (_r, { id }) => {
      await restartDeploPanel(id);
      return true;
    },
  }),
}));
