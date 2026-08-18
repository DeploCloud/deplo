"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Layers,
  Link2,
  RotateCcw,
  Server as ServerIcon,
  Users,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { WizardStepper, type WizardStep } from "@/components/shared/wizard-stepper";
import { DataStep, loadDataPlan, type DataService } from "./data-step";
import { ImportTree } from "./import-tree";
import {
  ImportProgressDialog,
  ImportProgressPill,
  ItemLine,
  type ImportProgress,
} from "./import-progress";
import {
  importableOf,
  type ImportRun,
  type Invite,
  type Placement,
  type Plan,
  type PlanMember,
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

type StepId = "connect" | "review" | "data" | "people" | "done";

/**
 * The steps that exist for THIS import.
 *
 * `data` only when the cutover has something to copy - either the plan read
 * after the import found volumes, or the user came in from an earlier run to do
 * exactly that. `people` only for an instance admin, because both of its actions
 * are instance-admin gated and the step would otherwise be a page of nothing.
 *
 * The team is deliberately NOT a step. Dokploy scopes an API key to one
 * organization and Deplo scopes everything to the active team, so a run goes from
 * the one to the other; making that a screen of its own gave a foregone conclusion
 * the same weight as the work. Neither is the server mapping: it is a block at the
 * top of Review, where it belongs, and with one server it is not even a question.
 */
function stepsFor(hasData: boolean, canInvite: boolean): WizardStep<StepId>[] {
  return [
    { id: "connect", label: "Connect" },
    { id: "review", label: "Review" },
    ...(hasData ? [{ id: "data" as StepId, label: "Data" }] : []),
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
            domains
            notes
          }
        }
      }
    }
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

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function ImportWizard({
  teamId,
  servers,
  buildServers,
  runs,
  isInstanceAdmin,
}: {
  teamId: string;
  servers: ServerChoice[];
  buildServers: ServerChoice[];
  runs: ImportRun[];
  isInstanceAdmin: boolean;
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

  const [dataPlan, setDataPlan] = React.useState<DataService[] | null>(null);
  const [dataLoading, setDataLoading] = React.useState(false);
  /**
   * Set when someone came back for an old run's cutover. The Data step normally
   * appears because the import just found volumes; this is the other way in, and
   * without it the "months later" path the Connect screen offers goes nowhere.
   */
  const [resuming, setResuming] = React.useState(false);

  const connectInput = React.useMemo(
    () => ({ url, apiKey, allowPrivate: sameMachine }),
    [url, apiKey, sameMachine],
  );

  const hasData = resuming || (dataPlan?.length ?? 0) > 0;
  const STEPS = React.useMemo(
    () => stepsFor(hasData, isInstanceAdmin),
    [hasData, isInstanceAdmin],
  );

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
    // Everything lands on the machine Deplo itself runs on unless someone says
    // otherwise: it is the one host every install has, and it is where an app
    // that came over to be looked at should be. Automatic for the build, which
    // is what "use a build server if the fleet has one" is called.
    const home = (servers.find((s) => s.isDeploHost) ?? servers[0])?.id;
    if (home) {
      setPlacements(
        Object.fromEntries(
          scanned.projects.flatMap((p) =>
            importableOf(p).map((svc) => [
              svc.sourceId,
              { serverId: home, buildServerId: null },
            ]),
          ),
        ),
      );
      // The SAME default for the other direction: the cutover asks which of our
      // servers can reach each Dokploy host, and the Data step is where that is
      // edited. Pre-answering it here means the common case (Dokploy on this very
      // machine) needs no answer at all.
      setServerMap(
        Object.fromEntries([
          [OWN_HOST, home],
          ...scanned.servers.map((s) => [s.sourceId, home]),
        ]),
      );
    }
    if (resuming) {
      void openData();
      return;
    }
    setStep("review");
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
        if (!res.ok) {
          setFailure(res.error);
          return;
        }
        setItems((prev) => [...prev, ...(res.data?.items ?? [])]);
      }

      setProgress({ done: targets.length, total: targets.length, current: "" });
      await gqlAction(FINISH, { runId: openRunId });
      router.refresh();
    } finally {
      setRunning(false);
    }

    // Only the happy path gets here: an early return above runs the `finally`
    // and leaves the dialog open on its error, which is where it belongs.
    // What can still be moved is read now, because whether the cutover is even a
    // step depends on the answer.
    setDataLoading(true);
    const next = await loadDataPlan(connectInput);
    setDataLoading(false);
    setDataPlan(next ?? []);
    setLogOpen(false);
    setStep(next && next.length > 0 ? "data" : isInstanceAdmin ? "people" : "done");
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

  /**
   * The run a report line belongs to, opening one if this session has none - a
   * cutover months after the import arrives here with nothing in hand, and that is
   * not a reason to send someone back through the import.
   */
  async function ensureRun(): Promise<string | null> {
    if (runId) return runId;
    const begun = await gqlAction<{ beginDokployImport: string }, string>(
      BEGIN,
      { url, orgName: plan?.orgName ?? null },
      (d) => d.beginDokployImport,
    );
    if (!begun.ok) {
      toast.error(begun.error);
      return null;
    }
    if (begun.data) setRunId(begun.data);
    return begun.data ?? null;
  }

  /**
   * Open the cutover step, reading both sides on the way in. Loaded from the
   * transition rather than from an effect inside the step: entering a step IS a
   * click, and an effect that sets state on mount is a cascading render.
   */
  async function openData() {
    setStep("data");
    if (dataLoading) return;
    setDataLoading(true);
    const next = await loadDataPlan(connectInput);
    setDataLoading(false);
    if (next) setDataPlan(next);
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
    setDataPlan(null);
    setResuming(false);
    router.refresh();
  }

  /** The step after the cutover, which depends on whether People exists at all. */
  const afterData: StepId = isInstanceAdmin ? "people" : "done";

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
          if (s === "review" || s === "data") return plan != null;
          // People and the report are what the import produces: an empty one is
          // worse than a chip that does not respond.
          return items.length > 0;
        }}
        onSelect={(s) => {
          // Nothing moves while the loop is mid-flight: the log is the only thing
          // worth looking at, and the pill is how you get back to it.
          if (running) return;
          if (s === "data") {
            void openData();
            return;
          }
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
          resuming={resuming}
          onSubmit={scan}
          runs={runs}
          onPickRun={(run) => {
            // Resume an old migration for its cutover: the address comes back,
            // the key never does (it was never stored), and the copy's report
            // lands on the run it belongs to.
            setUrl(run.sourceUrl);
            setRunId(run.id);
            setResuming(true);
            toast.info("Paste the API key again to pick up that migration");
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

      {step === "data" && (
        <DataStep
          connectInput={connectInput}
          ensureRun={ensureRun}
          servers={servers}
          serverMap={serverMap}
          setServerMap={setServerMap}
          plan={dataPlan}
          loading={dataLoading}
          onReload={() => void openData()}
          onBack={() => setStep("review")}
          // Someone who came back only for the cutover has no report to read and
          // nobody to invite: for them this IS the last screen.
          onNext={() => (items.length > 0 ? setStep(afterData) : router.push("/"))}
          nextLabel={items.length > 0 ? "Continue" : "Finish"}
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
        <DoneStep items={items} onStartOver={startOver} onFinish={() => router.push("/")} />
      )}

      {/* The import, wherever you are. The pill only exists while there is a run
          worth reopening, and the report itself replaces it on the last step. */}
      <ImportProgressDialog
        open={logOpen}
        onOpenChange={setLogOpen}
        progress={progress}
        items={items}
        failure={failure}
        running={running || dataLoading}
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
  resuming,
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
  resuming: boolean;
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
                {scanning
                  ? "Reading Dokploy"
                  : resuming
                    ? "Open the data"
                    : "Continue"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {runs.length > 0 && <PastRuns runs={runs} onPick={onPickRun} />}
    </div>
  );
}

function PastRuns({
  runs,
  onPick,
}: {
  runs: ImportRun[];
  onPick: (run: ImportRun) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Earlier imports</CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          What this team has already brought over.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {runs.slice(0, 5).map((r) => (
          <div
            key={r.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3 text-sm"
          >
            <div className="min-w-0">
              <div className="truncate font-medium">
                {r.orgName ?? r.sourceUrl}
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {new Date(r.startedAt).toLocaleString()} by {r.actor}
              </p>
            </div>
            <div className="flex items-center gap-1.5">
              <Badge variant="secondary">{r.created} created</Badge>
              {r.manual > 0 && <Badge variant="outline">{r.manual} to check</Badge>}
              {r.failed > 0 && <Badge variant="destructive">{r.failed} failed</Badge>}
              {r.status !== "done" && <Badge variant="outline">{r.status}</Badge>}
              <Button variant="outline" size="sm" onClick={() => onPick(r)}>
                Move the data
              </Button>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
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
  setPlacements: (v: Record<string, Placement>) => void;
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
  const pickable = plan.projects.flatMap((p) => importableOf(p));
  const allChosen = pickable.length > 0 && chosen.size === pickable.length;
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
        <CardContent>
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
            />
          )}
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack} disabled={running}>
          Back
        </Button>
        <Button
          onClick={onStart}
          disabled={running || chosen.size === 0 || servers.length === 0}
        >
          {running ? "Importing" : "Import"}
        </Button>
      </div>
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

const OUTCOME_ORDER = ["failed", "manual", "unsupported", "created", "skipped"];

const OUTCOME_TITLE: Record<string, string> = {
  failed: "Could not be imported",
  manual: "Imported, needs a look",
  unsupported: "No equivalent in Deplo",
  created: "Created",
  skipped: "Skipped",
};

function DoneStep({
  items,
  onStartOver,
  onFinish,
}: {
  items: ReportItem[];
  onStartOver: () => void;
  onFinish: () => void;
}) {
  const groups = OUTCOME_ORDER.map((outcome) => ({
    outcome,
    rows: items.filter((i) => i.outcome === outcome),
  })).filter((g) => g.rows.length > 0);

  function copyReport() {
    const md = groups
      .map(
        (g) =>
          `## ${OUTCOME_TITLE[g.outcome] ?? g.outcome}\n\n` +
          g.rows
            .map(
              (r) =>
                `- **${r.path}** (${r.sourceKind})` +
                (r.message ? ` - ${r.message}` : ""),
            )
            .join("\n"),
      )
      .join("\n\n");
    navigator.clipboard.writeText(md);
    toast.success("Report copied");
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>Report</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              Nothing was deployed. Open an app and press Deploy when you are ready to
              move the traffic.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={copyReport}>
            <Copy className="size-4" />
            Copy
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {groups.map((g) => (
            <div key={g.outcome}>
              <div className="text-sm font-medium">
                {OUTCOME_TITLE[g.outcome] ?? g.outcome}
                <span className="ml-2 text-muted-foreground">{g.rows.length}</span>
              </div>
              <div className="mt-1 space-y-1">
                {g.rows.map((r, i) => (
                  <ItemLine key={i} item={r} />
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

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
