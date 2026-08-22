"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Layers,
  Link2,
  RotateCcw,
  Server as ServerIcon,
  TriangleAlert,
  Users,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { WizardStepper, type WizardStep } from "@/components/shared/wizard-stepper";
import { MachineGate } from "./machines";
import { ImportReport } from "./import-report";
import { RemoveMigrationSources } from "./remove-sources";
import { ImportTree, type PortConflict } from "./import-tree";
import {
  ImportProgressDialog,
  ImportProgressPill,
  type ImportProgress,
} from "./import-progress";
import {
  importableOf,
  type ImportRun,
  type Invite,
  type Placement,
  type Plan,
  type PlanMember,
  type PortCheck,
  type ReportItem,
  type ServerChoice,
} from "./types";

/**
 * Import from Dokploy, as one screen.
 *
 * Connect, review, move the data, invite the people, read the report. The import
 * itself is NOT a step: it is a dialog you can close, because watching a progress
 * bar is not a decision and a wizard that parks you in front of one is a wizard
 * that makes you wait for it. A pill puts it back at any point.
 *
 * The API key never leaves this component's state. It is sent with each call and
 * stored nowhere, which is why the import is driven from here (one project per
 * request) instead of handed to a background job.
 */

type StepId = "connect" | "review" | "people" | "done";

/**
 * The steps, and there is no longer a separate one for the data.
 *
 * The cutover used to be its own screen at the end, reachable months later. It
 * moved INTO the import: Connect now refuses to continue until Deplo has an
 * agent on every machine behind that Dokploy, which is what makes copying the
 * data possible at all - so by the time the import runs, it can always do it.
 *
 * `people` only for an instance admin, because both of its actions are
 * instance-admin gated and the step would otherwise be a page of nothing.
 */
function stepsFor(canInvite: boolean): WizardStep<StepId>[] {
  return [
    { id: "connect", label: "Connect" },
    { id: "review", label: "Review" },
    ...(canInvite ? [{ id: "people" as StepId, label: "People" }] : []),
    { id: "done", label: "Done" },
  ];
}

/** Dokploy's own host has no server row over there; it is the empty id. */
const OWN_HOST = "";

/* ------------------------------------------------------------------ */
/* GraphQL                                                            */
/* ------------------------------------------------------------------ */

const SCAN = /* GraphQL */ `
  mutation ScanDokploy($input: DokployConnectInput!) {
    scanDokploy(input: $input) {
      sourceUrl
      orgName
      servers {
        sourceId
        name
        ipAddress
        deploServerId
        deploServerName
      }
      members {
        email
        name
        sourceRole
        hasAccount
        inTeam
      }
      projects {
        sourceId
        name
        exists
        environments {
          sourceId
          name
          exists
          services {
            sourceId
            kind
            name
            targetKind
            status
            sourceServerId
            buildsFromSource
            engine
            exposedPort
            domains
            notes
          }
        }
      }
    }
  }
`;

const PORTS_IN_USE = /* GraphQL */ `
  query HostPortsInUse($serverId: ID!, $ports: [Int!]!) {
    hostPortsInUse(serverId: $serverId, ports: $ports) {
      checked
      inUse
      reason
    }
  }
`;

const SUGGEST_PORT = /* GraphQL */ `
  mutation GenerateAvailableDbPort($serverId: ID) {
    generateAvailableDbPort(serverId: $serverId)
  }
`;

const BEGIN = /* GraphQL */ `
  mutation BeginDokployImport($url: String!, $orgName: String) {
    beginDokployImport(url: $url, orgName: $orgName)
  }
`;

const IMPORT_PROJECT = /* GraphQL */ `
  mutation ImportDokployProject(
    $input: DokployConnectInput!
    $runId: String!
    $projectId: String!
    $servers: [DokployServerChoiceInput!]
    $serviceIds: [String!]
    $placements: [DokployPlacementInput!]
  ) {
    importDokployProject(
      input: $input
      runId: $runId
      projectId: $projectId
      servers: $servers
      serviceIds: $serviceIds
      placements: $placements
    ) {
      projectName
      created
      skipped
      failed
      manual
      items {
        path
        sourceKind
        sourceName
        outcome
        targetKind
        targetId
        message
      }
    }
  }
`;

const PLAN_DATA = /* GraphQL */ `
  mutation PlanDokployData($input: DokployConnectInput!, $runId: String!) {
    planDokployDataMove(input: $input, runId: $runId) {
      path
      sourceKind
      sourceId
      sourceName
      sourceServerId
      targetKind
      targetName
      running
      volumes {
        sourceVolume
      }
      notes
    }
  }
`;

const MOVE_DATA = /* GraphQL */ `
  mutation MoveDokployData(
    $input: DokployConnectInput!
    $runId: String!
    $sourceKind: String!
    $sourceId: String!
  ) {
    moveDokployServiceData(
      input: $input
      runId: $runId
      sourceKind: $sourceKind
      sourceId: $sourceId
    ) {
      moved
      failed
      notes
    }
  }
`;

const FINISH = /* GraphQL */ `
  mutation FinishDokployImport($runId: String!) {
    finishDokployImport(runId: $runId)
  }
`;

const IMPORT_MEMBERS = /* GraphQL */ `
  mutation ImportDokployMembers($input: DokployConnectInput!, $runId: String!) {
    importDokployMembers(input: $input, runId: $runId) {
      email
      name
      link
      outcome
      message
    }
  }
`;

const CREATE_TEAM = /* GraphQL */ `
  mutation CreateTeamForImport($name: String!) {
    createTeam(name: $name) {
      id
      name
    }
  }
`;

const MINT_LINK = /* GraphQL */ `
  mutation MintImportInviteLink($input: MintRegistrationLinkInput!) {
    mintRegistrationLink(input: $input)
  }
`;

/** What `planDokployDataMove` answers, trimmed to what the copy loop reads. */
interface DataService {
  path: string;
  sourceKind: string;
  sourceId: string;
  sourceName: string;
  volumes: { sourceVolume: string }[];
  /** Why a volume could not be paired, or why this host cannot be read at all.
   *  Shown, never swallowed: it is the line that says what will NOT come over. */
  notes: string[];
}

interface MoveResult {
  moved: number;
  failed: number;
  notes: string[];
}

/**
 * A copy's line in the same report the rest of the import writes to.
 *
 * The server records its own row against the run; this is the LIVE echo of it,
 * so the dialog shows the copy happening instead of going quiet for the minutes
 * a volume takes.
 */
function dataNote(message: string, outcome: string = "manual"): ReportItem {
  return {
    path: "Data",
    sourceKind: "volume",
    sourceName: "data",
    outcome,
    targetKind: null,
    targetId: null,
    message,
  };
}

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function ImportWizard({
  teamId,
  servers,
  buildServers,
  runs,
  isInstanceAdmin,
  canExposePorts,
}: {
  teamId: string;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  runs: ImportRun[];
  isInstanceAdmin: boolean;
  /** The publish-ports grant. Without it a database's port cannot come over at all. */
  canExposePorts: boolean;
}) {
  const router = useRouter();

  const [step, setStep] = React.useState<StepId>("connect");
  const [url, setUrl] = React.useState("");
  const [apiKey, setApiKey] = React.useState("");
  const [sameMachine, setSameMachine] = React.useState(false);
  const [scanning, setScanning] = React.useState(false);
  const [plan, setPlan] = React.useState<Plan | null>(null);

  const [serverMap, setServerMap] = React.useState<Record<string, string>>({});
  /** Source SERVICE ids. The leaves are the selection; the tree derives the rest. */
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  /** Source service id → where it lands. Filled for every importable service. */
  const [placements, setPlacements] = React.useState<Record<string, Placement>>({});

  const [newTeam, setNewTeam] = React.useState("");
  const [creatingTeam, setCreatingTeam] = React.useState(false);

  const [progress, setProgress] = React.useState<ImportProgress>({
    done: 0,
    total: 0,
    current: "",
  });
  const [items, setItems] = React.useState<ReportItem[]>([]);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);
  const [running, setRunning] = React.useState(false);
  const [logOpen, setLogOpen] = React.useState(false);

  const [invites, setInvites] = React.useState<Invite[] | null>(null);
  const [inviting, setInviting] = React.useState(false);
  const [inviteLink, setInviteLink] = React.useState<string | null>(null);
  const [minting, setMinting] = React.useState(false);


  const connectInput = React.useMemo(
    () => ({ url, apiKey, allowPrivate: sameMachine }),
    [url, apiKey, sameMachine],
  );

  const STEPS = React.useMemo(() => stepsFor(isInstanceAdmin), [isInstanceAdmin]);

  /* ---- step 1: connect --------------------------------------------- */

  async function scan(e: React.FormEvent) {
    e.preventDefault();
    setScanning(true);
    const res = await gqlAction<{ scanDokploy: Plan }, Plan>(
      SCAN,
      { input: connectInput },
      (d) => d.scanDokploy,
    );
    setScanning(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    if (!res.data) return;
    const scanned = res.data;
    setPlan(scanned);
    // The organization's own name is the team's name in every case anyone actually
    // wants, so it arrives already typed rather than as a placeholder to copy.
    if (scanned.orgName && !newTeam) setNewTeam(scanned.orgName);
    // Everything Deplo can actually create is picked; anything already here is
    // not, since re-importing it would only produce a page of "already here" rows.
    setChosen(
      new Set(
        scanned.projects.flatMap((p) =>
          importableOf(p)
            .filter((s) => s.status !== "exists")
            .map((s) => s.sourceId),
        ),
      ),
    );
    // A service lands on the Deplo server that IS the Dokploy machine it runs on,
    // whenever the scan matched one by address - staying put is what somebody
    // moving twenty-five services means by "import", and re-picking the host on
    // twenty-five dropdowns is not a choice, it is a chore. Anything with no
    // match (a machine with no agent here) falls back to the host Deplo runs on,
    // the one host every install has.
    const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
    const runnable = new Set(servers.map((s) => s.id));
    const byMachine = new Map(
      scanned.servers.map((m) => [
        m.sourceId,
        m.deploServerId && runnable.has(m.deploServerId) ? m.deploServerId : home,
      ]),
    );
    const landingFor = (sourceServerId: string) =>
      byMachine.get(sourceServerId) ?? home;
    if (home) {
      setPlacements(
        Object.fromEntries(
          scanned.projects.flatMap((p) =>
            importableOf(p).map((svc) => [
              svc.sourceId,
              { serverId: landingFor(svc.sourceServerId), buildServerId: null },
            ]),
          ),
        ),
      );
      // The same default for a service whose placement was never touched: which of
      // our servers its apps LAND on. It is only that - where the data is READ from
      // is derived server-side from the machine's address, never from this map.
      // Answering both questions with one field is what made every copy read the
      // Deplo host, find no volume there, and overwrite real data with nothing.
      setServerMap(
        Object.fromEntries([
          [OWN_HOST, landingFor(OWN_HOST)],
          ...scanned.servers.map((s) => [s.sourceId, landingFor(s.sourceId)]),
        ]),
      );
    }
    // Deliberately NOT advancing: Connect's second half is the machine list, and
    // whether Deplo can reach every one of them is the question this step exists
    // to answer. Continue there moves on.
  }

  /* ---- step 2: destination ----------------------------------------- */

  async function createTeamAndSwitch(e: React.FormEvent) {
    e.preventDefault();
    const name = newTeam.trim();
    if (!name) return;
    setCreatingTeam(true);
    const res = await gqlAction<{ createTeam: { name: string } | null }>(
      CREATE_TEAM,
      { name },
    );
    setCreatingTeam(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    // createTeam switches the active team, and everything is imported into the
    // active team - so the page has to re-read before the import starts.
    toast.success(`Switched to ${name}`);
    setNewTeam("");
    router.refresh();
  }

  /* ---- the import itself (a dialog, not a step) --------------------- */

  async function runImport() {
    // The loop is re-entrant from the Review screen, which stays behind the
    // dialog: closing the dialog mid-run leaves its Import button one click from
    // a second run over the same projects. The button is disabled for it too;
    // this is the guard that does not depend on the rendering being right.
    if (!plan || running) return;
    const targets = plan.projects
      .map((p) => ({
        project: p,
        serviceIds: importableOf(p)
          .filter((s) => chosen.has(s.sourceId))
          .map((s) => s.sourceId),
      }))
      .filter((t) => t.serviceIds.length > 0);
    if (targets.length === 0) return;

    setItems([]);
    setFailure(null);
    setProgress({ done: 0, total: targets.length, current: targets[0].project.name });
    setRunning(true);
    setLogOpen(true);

    try {
      const begun = await gqlAction<{ beginDokployImport: string }, string>(
        BEGIN,
        { url, orgName: plan.orgName },
        (d) => d.beginDokployImport,
      );
      if (!begun.ok) {
        setFailure(begun.error);
        return;
      }
      if (!begun.data) {
        setFailure("Deplo could not open an import run.");
        return;
      }
      const openRunId = begun.data;
      setRunId(openRunId);

      const serverChoices = Object.entries(serverMap)
        .filter(([, to]) => to)
        .map(([from, to]) => ({ from, to }));

      for (const [i, target] of targets.entries()) {
        setProgress({ done: i, total: targets.length, current: target.project.name });
        const res = await gqlAction<
          { importDokployProject: { items: ReportItem[] } },
          { items: ReportItem[] }
        >(
          IMPORT_PROJECT,
          {
            input: connectInput,
            runId: openRunId,
            projectId: target.project.sourceId,
            servers: serverChoices,
            serviceIds: target.serviceIds,
            placements: target.serviceIds
              .filter((id) => placements[id])
              .map((id) => ({ serviceId: id, ...placements[id] })),
          },
          (d) => d.importDokployProject,
        );
        // One project failing does not abandon the others, and above all does not
        // skip the DATA phase: the projects that did land are already created here
        // and stopped over there, and leaving them without their data is the worse
        // half-finished state.
        if (!res.ok) {
          setItems((prev) => [
            ...prev,
            {
              path: target.project.name,
              sourceKind: "project",
              sourceName: target.project.name,
              outcome: "failed",
              targetKind: null,
              targetId: null,
              message: res.error,
            },
          ]);
          continue;
        }
        setItems((prev) => [...prev, ...(res.data?.items ?? [])]);
      }

      // ---- the data ------------------------------------------------
      // The configuration is here; now the bytes. Read both sides once, then
      // copy every service that actually has a volume - the ones with none (a
      // git-built app, usually) have nothing to do here.
      setProgress({ done: targets.length, total: targets.length, current: "Reading the volumes" });
      const dataPlan = await gqlAction<{ planDokployDataMove: DataService[] }, DataService[]>(
        PLAN_DATA,
        { input: connectInput, runId: openRunId },
        (d) => d.planDokployDataMove,
      );
      if (!dataPlan.ok)
        setItems((prev) => [
          ...prev,
          dataNote("Could not read what data is on Dokploy: " + dataPlan.error, "failed"),
        ]);
      const planned = dataPlan.ok ? (dataPlan.data ?? []) : [];
      // Every reason a service will not have its data copied is SAID. These notes
      // are the whole value of the report - "no volume of this app mounts that
      // path", "Deplo has no agent on that machine" - and they used to be fetched
      // and dropped on the floor, which is how a migration reads as complete while
      // leaving data behind.
      for (const d of planned)
        for (const note of d.notes)
          setItems((prev) => [...prev, dataNote(`${d.sourceName}: ${note}`)]);
      const movable = planned.filter((d) => d.volumes.length > 0);

      for (const [i, d] of movable.entries()) {
        setProgress({ done: i, total: movable.length, current: `Copying ${d.sourceName}` });
        const res = await gqlAction<{ moveDokployServiceData: MoveResult }, MoveResult>(
          MOVE_DATA,
          {
            input: connectInput,
            runId: openRunId,
            sourceKind: d.sourceKind,
            sourceId: d.sourceId,
          },
          (d2) => d2.moveDokployServiceData,
        );
        // One failed copy never stops the rest: the others are already stopped on
        // Dokploy, and leaving them half-moved is worse than finishing the list.
        setItems((prev) => [
          ...prev,
          res.ok
            ? dataNote(
                `${d.sourceName}: ${res.data?.moved ?? 0} volume(s) copied` +
                  ((res.data?.failed ?? 0) > 0 ? `, ${res.data!.failed} failed` : ""),
                (res.data?.failed ?? 0) > 0 ? "failed" : "created",
              )
            : dataNote(`${d.sourceName}: ${res.error}`, "failed"),
        ]);
      }

      setProgress({ done: movable.length, total: movable.length, current: "" });
      await gqlAction(FINISH, { runId: openRunId });
      router.refresh();
    } finally {
      setRunning(false);
    }

    // Only the happy path gets here: an early return above runs the `finally`
    // and leaves the dialog open on its error, which is where it belongs.
    setLogOpen(false);
    setStep(isInstanceAdmin ? "people" : "done");
  }

  /* ---- step: people ------------------------------------------------ */

  async function inviteMembers() {
    if (!runId) return;
    setInviting(true);
    const res = await gqlAction<{ importDokployMembers: Invite[] }, Invite[]>(
      IMPORT_MEMBERS,
      { input: connectInput, runId },
      (d) => d.importDokployMembers,
    );
    setInviting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setInvites(res.data ?? []);
    router.refresh();
  }

  async function mintInviteLink() {
    setMinting(true);
    const res = await gqlAction<{ mintRegistrationLink: string }, string>(
      MINT_LINK,
      { input: { mode: "existing_teams", teamAssignments: [{ teamId, role: "member" }] } },
      (d) => d.mintRegistrationLink,
    );
    setMinting(false);
    if (!res.ok) {
      toast.error(res.error);
      return;
    }
    setInviteLink(res.data ?? null);
    router.refresh();
  }

  /** A machine's agent just came up: it is now one of ours. */
  function machineResolved(sourceId: string, serverId: string, serverName: string) {
    setPlan((prev) =>
      prev
        ? {
            ...prev,
            servers: prev.servers.map((m) =>
              m.sourceId === sourceId
                ? { ...m, deploServerId: serverId, deploServerName: serverName }
                : m,
            ),
          }
        : prev,
    );
    // A machine that just became one of ours is also the obvious place for its own
    // services to land, so it becomes their default placement.
    setServerMap((prev) => ({ ...prev, [sourceId]: serverId }));
  }

  /** Back to a blank wizard, same page, nothing carried over but the address. */
  function startOver() {
    setStep("connect");
    setApiKey("");
    setPlan(null);
    setChosen(new Set());
    setPlacements({});
    // Both belong to the instance that was just imported: the mapping keys are
    // ITS server ids, and the team name was ITS organization's.
    setServerMap({});
    setNewTeam("");
    setProgress({ done: 0, total: 0, current: "" });
    setItems([]);
    setRunId(null);
    setFailure(null);
    setInvites(null);
    setInviteLink(null);
    router.refresh();
  }

  /* ---- render ------------------------------------------------------ */

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import"
        description="Bring projects, apps and their configuration over from Dokploy."
      />

      <WizardStepper
        steps={STEPS}
        current={step}
        reachable={(s) => {
          if (s === "connect") return true;
          if (s === "review") return plan != null;
          // People and the report are what the import produces: an empty one is
          // worse than a chip that does not respond.
          return items.length > 0;
        }}
        onSelect={(s) => {
          // Nothing moves while the loop is mid-flight: the log is the only thing
          // worth looking at, and the pill is how you get back to it.
          if (running) return;
          setStep(s);
        }}
      />

      {step === "connect" && (
        <ConnectStep
          url={url}
          setUrl={setUrl}
          apiKey={apiKey}
          setApiKey={setApiKey}
          sameMachine={sameMachine}
          setSameMachine={setSameMachine}
          canUsePrivate={isInstanceAdmin}
          scanning={scanning}
          plan={plan}
          onMachineResolved={machineResolved}
          onContinue={() => setStep("review")}
          onSubmit={scan}
          runs={runs}
          onPickRun={(run) => {
            // The address back in the field, nothing more: the data now moves
            // during the import, so there is no cutover to come back for. The
            // key was never stored and never will be.
            setUrl(run.sourceUrl);
          }}
        />
      )}

      {step === "review" && plan && (
        <ReviewStep
          plan={plan}
          chosen={chosen}
          setChosen={setChosen}
          servers={servers}
          buildServers={buildServers}
          placements={placements}
          setPlacements={setPlacements}
          canExposePorts={canExposePorts}
          isInstanceAdmin={isInstanceAdmin}
          newTeam={newTeam}
          setNewTeam={setNewTeam}
          creatingTeam={creatingTeam}
          onCreateTeam={createTeamAndSwitch}
          onBack={() => setStep("connect")}
          onStart={() => void runImport()}
          running={running}
        />
      )}

      {step === "people" && (
        <PeopleStep
          people={(plan?.members ?? []).filter((m) => !m.inTeam)}
          invites={invites}
          inviting={inviting}
          onInvite={inviteMembers}
          canInvitePeople={runId != null}
          inviteLink={inviteLink}
          minting={minting}
          onMintLink={() => void mintInviteLink()}
          onContinue={() => setStep("done")}
        />
      )}

      {step === "done" && (
        <DoneStep
          items={items}
          onStartOver={startOver}
          onFinish={() => router.push("/")}
          isInstanceAdmin={isInstanceAdmin}
        />
      )}

      {/* The import, wherever you are. The pill only exists while there is a run
          worth reopening, and the report itself replaces it on the last step. */}
      <ImportProgressDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        progress={progress}
        items={items}
        failure={failure}
        running={running}
      />
      {!logOpen && progress.total > 0 && step !== "done" && (
        <ImportProgressPill
          progress={progress}
          running={running}
          failure={failure}
          onOpen={() => setLogOpen(true)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 - connect                                                   */
/* ------------------------------------------------------------------ */

function ConnectStep({
  url,
  setUrl,
  apiKey,
  setApiKey,
  sameMachine,
  setSameMachine,
  canUsePrivate,
  scanning,
  plan,
  onMachineResolved,
  onContinue,
  onSubmit,
  runs,
  onPickRun,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  sameMachine: boolean;
  setSameMachine: (v: boolean) => void;
  canUsePrivate: boolean;
  scanning: boolean;
  /** Null until the address and key have been checked. */
  plan: Plan | null;
  onMachineResolved: (sourceId: string, serverId: string, serverName: string) => void;
  onContinue: () => void;
  onSubmit: (e: React.FormEvent) => void;
  runs: ImportRun[];
  onPickRun: (run: ImportRun) => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Connect to Dokploy</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Nothing is written on either side until you review what will come over.
          </p>
        </CardHeader>
        <CardContent>
          <form className="grid gap-4" onSubmit={onSubmit}>
            <div className="grid gap-2">
              <FieldLabel
                htmlFor="dokploy-url"
                info="The address you open Dokploy on. Deplo adds /api itself."
              >
                Address
              </FieldLabel>
              <Input
                id="dokploy-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={sameMachine ? "http://172.17.0.1:3000" : "https://dokploy.acme.com"}
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            <div className="grid gap-2">
              <FieldLabel
                htmlFor="dokploy-key"
                info="In Dokploy: Settings, Profile, API/CLI. Use an owner's or admin's key - a plain member's key is refused on the per-service calls."
              >
                API key
              </FieldLabel>
              <Input
                id="dokploy-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste the key"
                autoComplete="off"
                spellCheck={false}
              />
            </div>

            {canUsePrivate && (
              <div className="flex items-start justify-between gap-4 rounded-lg border p-3">
                <div className="min-w-0">
                  <FieldLabel htmlFor="same-machine">
                    Dokploy runs on this machine
                  </FieldLabel>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Allows a private address. From inside Deplo, Dokploy is usually
                    reachable at <code>http://172.17.0.1:3000</code> or on the host&apos;s
                    own IP.
                  </p>
                </div>
                <Switch
                  id="same-machine"
                  checked={sameMachine}
                  onCheckedChange={setSameMachine}
                />
              </div>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={scanning || !url.trim() || !apiKey.trim()}>
                {scanning ? "Reading Dokploy" : "Check this Dokploy"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {/* The gate. Continue stays shut until Deplo has an agent on every machine
          behind that Dokploy, because that is what makes the data movable at all
          - and a database that arrives empty because nobody mentioned an agent is
          the failure this whole screen exists to prevent. */}
      {plan && (
        <>
          <MachineGate
            machines={plan.servers}
            canAddServers={canUsePrivate}
            onResolved={onMachineResolved}
          />
          <div className="flex justify-end">
            <Button
              onClick={onContinue}
              disabled={plan.servers.some((m) => !m.deploServerId)}
            >
              Continue
            </Button>
          </div>
        </>
      )}

      {runs.length > 0 && <PastRuns runs={runs} onPick={onPickRun} />}
    </div>
  );
}

const PAST_RUNS_SHOWN = 5;

function PastRuns({
  runs,
  onPick,
}: {
  runs: ImportRun[];
  onPick: (run: ImportRun) => void;
}) {
  const [showAll, setShowAll] = React.useState(false);
  const shown = showAll ? runs : runs.slice(0, PAST_RUNS_SHOWN);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Earlier imports</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          What this team has already brought over.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {shown.map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
          >
            {/* `basis-48` so the name keeps a readable width and the buttons drop
                to their own line on a phone instead of pushing the card wider
                than the screen. */}
            <div className="min-w-0 flex-1 basis-48">
              <div className="truncate font-medium">
                {r.orgName ?? r.sourceUrl}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {new Date(r.startedAt).toLocaleString()} by {r.actor}
              </p>
            </div>
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{r.created} created</Badge>
              {r.manual > 0 && <Badge variant="outline">{r.manual} to check</Badge>}
              {r.failed > 0 && <Badge variant="destructive">{r.failed} failed</Badge>}
              {r.status !== "done" && <Badge variant="outline">{r.status}</Badge>}
              <Button variant="outline" size="sm" asChild>
                <Link href={`/settings/import/${r.id}`}>View report</Link>
              </Button>
              <Button variant="outline" size="sm" onClick={() => onPick(r)}>
                Use this address
              </Button>
            </div>
          </div>
        ))}
        {runs.length > PAST_RUNS_SHOWN && !showAll && (
          <Button variant="ghost" size="sm" onClick={() => setShowAll(true)}>
            Show all
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Host ports                                                         */
/* ------------------------------------------------------------------ */

/** Every database in the plan that publishes a port, whatever anyone has ticked. */
function databasesWithPorts(plan: Plan) {
  return plan.projects
    .flatMap(importableOf)
    .filter((s) => s.targetKind === "database" && s.exposedPort != null);
}

/**
 * Which databases would land on a host port something else already holds, and a
 * free port to offer instead.
 *
 * The whole point is that this is answered BEFORE the import, not after: the port
 * a database publishes on the other platform is routinely taken over here (by
 * Deplo's own Postgres on 5432, by an app, by the other database in the same
 * migration), and an import that discovers that at the create can only drop the
 * port and write a line about it in a report nobody reads until it is too late.
 *
 * Two things are deliberately NOT a conflict:
 *
 * - **The source itself holding it.** When the database runs on the very machine
 *   it is about to run on here, the container holding that port is the one being
 *   imported, and the import stops it moments later to read its volume - so the
 *   port frees itself and asking about it would be asking about nothing.
 * - **A port on a server nothing could ask.** An agent too old to probe, or one
 *   that will not answer, is reported once at the top rather than turned into a
 *   decision per database about a problem that may not exist.
 *
 * Duplicates inside the same import are found here and nowhere else: neither
 * database exists yet, so the host has nothing to bind and the probe cannot see
 * the clash - only this list can.
 */
function usePortConflicts({
  plan,
  placements,
  setPlacements,
  chosen,
  servers,
  enabled,
}: {
  plan: Plan;
  placements: Record<string, Placement>;
  /** The real setter: a suggestion lands after an await, so it must merge, not overwrite. */
  setPlacements: React.Dispatch<React.SetStateAction<Record<string, Placement>>>;
  chosen: Set<string>;
  servers: ServerChoice[];
  /** False without the publish-ports grant: nothing can be published, so nothing is asked. */
  enabled: boolean;
}) {
  const [checks, setChecks] = React.useState<Record<string, PortCheck>>({});

  const dbs = React.useMemo(() => databasesWithPorts(plan), [plan]);

  /** The Deplo server that IS the Dokploy machine a service runs on, if we have one. */
  const homeHost = React.useMemo(
    () => new Map(plan.servers.map((m) => [m.sourceId, m.deploServerId])),
    [plan],
  );

  /** What a database will publish, after whatever the review has decided so far. */
  const chosenPort = React.useCallback(
    (sourceId: string, sourcePort: number | null) => {
      const p = placements[sourceId]?.exposedPort;
      return p !== undefined ? p : sourcePort;
    },
    [placements],
  );

  // The question to ask each server: the ports its databases came with, plus the
  // ones the review has since chosen, so a typed port is checked too. Serialised
  // to a string because it is what the effect keys on - an array rebuilt every
  // render would make it fire forever.
  const askKey = React.useMemo(() => {
    const byServer = new Map<string, Set<number>>();
    for (const s of dbs) {
      const serverId = placements[s.sourceId]?.serverId;
      if (!serverId) continue;
      const ports = byServer.get(serverId) ?? new Set<number>();
      if (s.exposedPort != null) ports.add(s.exposedPort);
      const now = chosenPort(s.sourceId, s.exposedPort);
      if (now != null) ports.add(now);
      byServer.set(serverId, ports);
    }
    return JSON.stringify(
      [...byServer].map(([id, ports]) => [id, [...ports].sort((a, b) => a - b)]),
    );
  }, [dbs, placements, chosenPort]);

  React.useEffect(() => {
    if (!enabled || dbs.length === 0) return;
    const ask: [string, number[]][] = JSON.parse(askKey);
    if (ask.length === 0) return;
    let cancelled = false;
    // Debounced: the run-server picker and the port field both feed this, and a
    // probe per keystroke is a gRPC round-trip per keystroke.
    const t = setTimeout(async () => {
      const answers = await Promise.all(
        ask.map(async ([serverId, ports]) => {
          const res = await gqlAction<{ hostPortsInUse: PortCheck }, PortCheck>(
            PORTS_IN_USE,
            { serverId, ports },
            (d) => d.hostPortsInUse,
          );
          const answer: PortCheck =
            res.ok && res.data
              ? res.data
              : {
                  checked: false,
                  inUse: [],
                  reason: res.ok ? null : res.error,
                };
          return [serverId, answer] as const;
        }),
      );
      if (cancelled) return;
      setChecks(Object.fromEntries(answers));
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [askKey, enabled, dbs.length]);

  /** A port taken on the host this database lands on, by something that is not it. */
  const clashes = React.useCallback(
    (sourceId: string, sourceServerId: string, port: number | null) => {
      if (port == null) return false;
      const serverId = placements[sourceId]?.serverId;
      if (!serverId) return false;
      // The container holding it is the one we are importing; it lets go.
      if (homeHost.get(sourceServerId) === serverId) return false;
      const check = checks[serverId];
      if (check?.checked && check.inUse.includes(port)) return true;
      // Nothing on the host can see a database that does not exist yet, so two
      // arrivals wanting one port are only ever caught by comparing them.
      return dbs.some(
        (o) =>
          o.sourceId !== sourceId &&
          placements[o.sourceId]?.serverId === serverId &&
          chosenPort(o.sourceId, o.exposedPort) === port &&
          // Ordered, so exactly ONE of the pair is the one to move.
          o.sourceId < sourceId,
      );
    },
    [placements, homeHost, checks, dbs, chosenPort],
  );

  const conflicts = React.useMemo(() => {
    const out: Record<string, PortConflict> = {};
    for (const s of dbs) {
      // Only what is actually coming over: a port on a database somebody unticked
      // is a question about something that is not going to happen.
      if (!chosen.has(s.sourceId)) continue;
      if (s.exposedPort == null) continue;
      if (!clashes(s.sourceId, s.sourceServerId, s.exposedPort)) continue;
      const serverId = placements[s.sourceId]?.serverId;
      out[s.sourceId] = {
        takenPort: s.exposedPort,
        serverName: servers.find((v) => v.id === serverId)?.name ?? "that server",
        invalid: clashes(
          s.sourceId,
          s.sourceServerId,
          chosenPort(s.sourceId, s.exposedPort),
        ),
      };
    }
    return out;
  }, [dbs, chosen, clashes, placements, servers, chosenPort]);

  // A free port, offered rather than demanded: whoever has no opinion about which
  // port a migrated database answers on presses Import and gets a working one.
  React.useEffect(() => {
    // Only a row nobody has touched: once a port has been chosen - by this effect
    // or by the person - it stands, even if it is still taken. Which is also what
    // stops this from looping, since the pick immediately fails this test.
    const open = dbs
      .filter(
        (s) =>
          conflicts[s.sourceId]?.invalid &&
          chosenPort(s.sourceId, s.exposedPort) === s.exposedPort,
      )
      .map((s) => s.sourceId);
    if (open.length === 0) return;
    let cancelled = false;
    void (async () => {
      const picked: [string, number][] = [];
      for (const id of open) {
        const serverId = placements[id]?.serverId;
        if (!serverId) continue;
        const res = await gqlAction<{ generateAvailableDbPort: number }, number>(
          SUGGEST_PORT,
          { serverId },
          (d) => d.generateAvailableDbPort,
        );
        // Two databases suggested in one pass must not be handed the same port:
        // the server answers from what is live, and neither of them is.
        if (res.ok && res.data != null && !picked.some(([, p]) => p === res.data)) {
          picked.push([id, res.data]);
        }
      }
      if (cancelled || picked.length === 0) return;
      // Merged into whatever is current, not into the copy this effect started
      // with: the picks arrive after a round-trip, and a server changed in the
      // meantime must not be undone by them.
      setPlacements((cur) => {
        const next = { ...cur };
        for (const [id, port] of picked)
          if (next[id]) next[id] = { ...next[id], exposedPort: port };
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conflicts]);

  /** Servers whose agent could not answer, by name, for the one line that says so. */
  const unreachable = React.useMemo(
    () =>
      Object.entries(checks)
        .filter(([, c]) => !c.checked)
        .map(([id]) => servers.find((v) => v.id === id)?.name ?? id),
    [checks, servers],
  );

  /** Something still points at a port that is taken - the import waits. */
  const blocked = React.useMemo(
    () => Object.values(conflicts).some((c) => c.invalid),
    [conflicts],
  );

  return {
    conflicts,
    unreachable,
    blocked,
    /** How many databases would publish a port, of the ones being imported. */
    count: dbs.filter((s) => chosen.has(s.sourceId)).length,
  };
}

/* ------------------------------------------------------------------ */
/* Step 2 - review                                                    */
/* ------------------------------------------------------------------ */

function ReviewStep({
  plan,
  chosen,
  setChosen,
  servers,
  buildServers,
  placements,
  setPlacements,
  canExposePorts,
  isInstanceAdmin,
  newTeam,
  setNewTeam,
  creatingTeam,
  onCreateTeam,
  onBack,
  onStart,
  running,
}: {
  plan: Plan;
  chosen: Set<string>;
  setChosen: (v: Set<string>) => void;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  placements: Record<string, Placement>;
  setPlacements: React.Dispatch<React.SetStateAction<Record<string, Placement>>>;
  canExposePorts: boolean;
  isInstanceAdmin: boolean;
  newTeam: string;
  setNewTeam: (v: string) => void;
  creatingTeam: boolean;
  onCreateTeam: (e: React.FormEvent) => void;
  onBack: () => void;
  onStart: () => void;
  /** The import is mid-flight behind the dialog, so this screen is read-only. */
  running: boolean;
}) {
  const [showNewTeam, setShowNewTeam] = React.useState(false);
  const [confirming, setConfirming] = React.useState(false);
  const ports = usePortConflicts({
    plan,
    placements,
    setPlacements,
    chosen,
    servers,
    enabled: canExposePorts,
  });
  const pickable = plan.projects.flatMap((p) => importableOf(p));
  const allChosen = pickable.length > 0 && chosen.size === pickable.length;
  // The confirm names them. A search box above the tree filters what you SEE and
  // not what is ticked, so a count alone let somebody stop three services while
  // looking at one.
  const chosenNames = pickable.filter((s) => chosen.has(s.sourceId)).map((s) => s.name);
  return (
    <div className="space-y-4">
      {isInstanceAdmin && showNewTeam && (
        <form
          className="flex flex-wrap items-end gap-2 rounded-lg border p-3"
          onSubmit={onCreateTeam}
        >
          <div className="grid min-w-0 flex-1 gap-2">
            <FieldLabel
              htmlFor="import-team-name"
              info="Creating it also switches you to it, because everything is imported into the team you are in."
            >
              New team
            </FieldLabel>
            <Input
              id="import-team-name"
              value={newTeam}
              onChange={(e) => setNewTeam(e.target.value)}
              placeholder="Team name"
            />
          </div>
          <Button type="submit" disabled={creatingTeam || !newTeam.trim()}>
            {creatingTeam ? "Creating" : "Create team"}
          </Button>
        </form>
      )}

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>What will come over</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick what to bring and where it lands. Nothing is deployed - Dokploy
              keeps serving until you say so.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* The destination is already decided - an API key is scoped to one
                Dokploy organization and everything here to the active team - so
                it is not worth a sentence. Creating a team to import into still
                is, and this is the row that already holds the bulk actions. */}
            {isInstanceAdmin && !showNewTeam && (
              <Button variant="secondary" size="sm" onClick={() => setShowNewTeam(true)}>
                Create a new team
              </Button>
            )}
            {/* Nothing to select is not a disabled button, it is no button:
                the card below is already saying why. */}
            {pickable.length > 0 && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  setChosen(
                    allChosen ? new Set() : new Set(pickable.map((s) => s.sourceId)),
                  )
                }
              >
                {allChosen ? "Unselect all" : "Select all"}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Said once, at the top, instead of on every database it applies to:
              it is one fact about the person importing, not a property of each
              row, and repeating it N times is how a screen stops being read. */}
          {!canExposePorts && ports.count > 0 && (
            <PortsNotice>
              You can&rsquo;t publish ports, so{" "}
              {ports.count === 1 ? "1 database comes" : `${ports.count} databases come`}{" "}
              over without public access.
            </PortsNotice>
          )}
          {ports.unreachable.length > 0 && (
            <PortsNotice>
              Deplo can&rsquo;t check ports on {ports.unreachable.join(", ")}. Update
              the agent there, or check them after the import.
            </PortsNotice>
          )}
          {servers.length === 0 ? (
            // Without a host there is nothing to place anything on, so this
            // replaces the tree rather than sitting beside it.
            <EmptyState
              icon={ServerIcon}
              title="No server to deploy to"
              description="Add a server under Settings, Servers before importing."
            />
          ) : plan.projects.length === 0 ? (
            <EmptyState
              icon={Layers}
              title="Nothing to import"
              description="That Dokploy organization has no projects, or the key cannot see them."
            />
          ) : (
            <ImportTree
              projects={plan.projects}
              chosen={chosen}
              onChange={setChosen}
              servers={servers}
              buildServers={buildServers}
              placements={placements}
              onPlacementsChange={setPlacements}
              portConflicts={ports.conflicts}
              showPorts={canExposePorts}
            />
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={running}>
          Back
        </Button>
        <Button
          onClick={() => setConfirming(true)}
          disabled={
            running || chosen.size === 0 || servers.length === 0 || ports.blocked
          }
        >
          {running ? "Importing" : "Import"}
        </Button>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <form
            className="grid gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              setConfirming(false);
              onStart();
            }}
          >
            <DialogHeader>
              <DialogTitle>Move everything over?</DialogTitle>
              <DialogDescription>
                Deplo copies the data by reading it on the machine that holds it,
                and it cannot read a volume something is writing to.
              </DialogDescription>
            </DialogHeader>

            <div className="flex items-start gap-3 rounded-lg border border-warning/40 bg-warning/10 p-4 text-sm">
              <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning" />
              <div className="min-w-0">
                <div className="font-medium text-warning">
                  {chosenNames.length === 1
                    ? "This stops 1 service on Dokploy"
                    : `This stops ${chosenNames.length} services on Dokploy`}
                </div>
                <p className="mt-1 break-words text-muted-foreground">
                  {chosenNames.join(", ")}
                </p>
                <p className="mt-1 text-muted-foreground">
                  {chosenNames.length === 1 ? "It is" : "They are"} not started
                  again over there. Nothing starts here either: open each app and
                  press Deploy when you have checked it.
                </p>
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
              <Button type="submit">Stop and move</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One line about ports, in the warning colour the rest of this screen uses. */
function PortsNotice({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
      <TriangleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0 text-muted-foreground">{children}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step - people                                                      */
/* ------------------------------------------------------------------ */

function PeopleStep({
  people,
  invites,
  inviting,
  onInvite,
  canInvitePeople,
  inviteLink,
  minting,
  onMintLink,
  onContinue,
}: {
  people: PlanMember[];
  invites: Invite[] | null;
  inviting: boolean;
  onInvite: () => void;
  canInvitePeople: boolean;
  inviteLink: string | null;
  minting: boolean;
  onMintLink: () => void;
  onContinue: () => void;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>People</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Passwords cannot be moved, so everyone joins with a single-use link and
            arrives as a plain member whatever they were over there.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 rounded-lg border p-3">
            <div>
              <div className="text-sm font-medium">Invite link</div>
              <p className="mt-1 text-sm text-muted-foreground">
                One link, one person. Create another for the next one.
              </p>
            </div>
            {inviteLink && (
              <div className="flex flex-wrap items-center gap-2">
                <Input readOnly value={inviteLink} className="min-w-0 flex-1" />
                <Button
                  variant="outline"
                  onClick={() => {
                    navigator.clipboard.writeText(inviteLink);
                    toast.success("Invite link copied");
                  }}
                >
                  <Copy className="size-4" />
                  Copy
                </Button>
              </div>
            )}
            <Button variant="outline" onClick={onMintLink} disabled={minting}>
              <Link2 className="size-4" />
              {minting
                ? "Creating"
                : inviteLink
                  ? "Create another link"
                  : "Create invite link"}
            </Button>
          </div>

          {people.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody else was in that Dokploy organization.
            </p>
          ) : (
            <div className="space-y-2">
              <div>
                <div className="text-sm font-medium">
                  Found on Dokploy ({people.length})
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Anyone who already has a Deplo account is added straight away; the
                  rest get their own link.
                </p>
              </div>
              {invites == null ? (
                <>
                  {people.map((p) => (
                    <div
                      key={p.email}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                    >
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{p.email}</div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {p.sourceRole} on Dokploy
                        </p>
                      </div>
                      {p.hasAccount && <Badge variant="secondary">Has an account</Badge>}
                    </div>
                  ))}
                  <Button onClick={onInvite} disabled={inviting || !canInvitePeople}>
                    <Users className="size-4" />
                    {inviting ? "Creating links" : "Create their links"}
                  </Button>
                </>
              ) : (
                invites.map((inv) => (
                  <div
                    key={inv.email}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{inv.email}</div>
                      {inv.message && (
                        <p className="mt-1 text-xs text-muted-foreground">{inv.message}</p>
                      )}
                    </div>
                    {inv.link ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          navigator.clipboard.writeText(inv.link!);
                          toast.success("Registration link copied");
                        }}
                      >
                        <Copy className="size-4" />
                        Copy link
                      </Button>
                    ) : (
                      <Badge variant="secondary">{inv.outcome}</Badge>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* One button, because there is nothing on this step to fill in: pressing
          Continue without touching anything IS skipping it. A Skip beside a
          Continue that does the same thing is two names for one action. */}
      <div className="flex justify-end">
        <Button onClick={onContinue}>Continue</Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step - done                                                        */
/* ------------------------------------------------------------------ */

function DoneStep({
  items,
  onStartOver,
  onFinish,
  isInstanceAdmin,
}: {
  items: ReportItem[];
  onStartOver: () => void;
  onFinish: () => void;
  /** Uninstalling an agent is instance-admin, like every server action. */
  isInstanceAdmin: boolean;
}) {
  return (
    <div className="space-y-4">
      <ImportReport
        items={items}
        description="Nothing was deployed. Open an app and press Deploy when you are ready to move the traffic."
      />

      {/* Below the report, not above it: read what happened first, then hand the
          other platform's machine back. */}
      {isInstanceAdmin && <RemoveMigrationSources />}

      <div className="flex flex-wrap justify-between gap-2">
        <Button variant="outline" onClick={onStartOver}>
          <RotateCcw className="size-4" />
          Start another import
        </Button>
        <Button onClick={onFinish}>Finish</Button>
      </div>
    </div>
  );
}
