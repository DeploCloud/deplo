"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  AlertTriangle,
  Check,
  CircleSlash,
  Copy,
  Database,
  DownloadCloud,
  Layers,
  Lock,
  Server as ServerIcon,
  SkipForward,
  Users,
} from "lucide-react";

import { gqlAction } from "@/lib/graphql-client";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { FieldLabel } from "@/components/ui/info-tip";
import { PageHeader } from "@/components/shared/page-header";
import { EmptyState } from "@/components/shared/empty-state";
import { WizardStepper, type WizardStep } from "@/components/shared/wizard-stepper";

/**
 * Import from Dokploy, as one screen.
 *
 * Renders inline rather than in a dialog for the same reason the MCP wizard does:
 * this IS the page. Five steps, and the third one is the point of the whole
 * feature - a preview that already knows which hostname belongs to another team
 * and which compose file needs a grant, so nobody finds out halfway through.
 *
 * The API key never leaves this component's state. It is sent with each call and
 * stored nowhere, which is why the import is driven from here (one project per
 * request) instead of handed to a background job.
 */

/* ------------------------------------------------------------------ */
/* Wire types (mirrors of the DTOs in lib/data/dokploy-import.ts)      */
/* ------------------------------------------------------------------ */

interface PlanService {
  sourceId: string;
  kind: string;
  name: string;
  targetKind: string | null;
  status: "new" | "exists" | "unsupported" | "needs_grant";
  sourceServerId: string;
  domains: string[];
  notes: string[];
}
interface PlanEnvironment {
  sourceId: string;
  name: string;
  exists: boolean;
  services: PlanService[];
}
interface PlanProject {
  sourceId: string;
  name: string;
  exists: boolean;
  environments: PlanEnvironment[];
}
interface PlanServer {
  sourceId: string;
  name: string;
  ipAddress: string | null;
}
interface PlanMember {
  email: string;
  name: string;
  sourceRole: string;
  hasAccount: boolean;
  inTeam: boolean;
}
interface Plan {
  sourceUrl: string;
  orgName: string | null;
  projects: PlanProject[];
  servers: PlanServer[];
  members: PlanMember[];
}
interface ReportItem {
  path: string;
  sourceKind: string;
  sourceName: string;
  outcome: string;
  targetKind: string | null;
  targetId: string | null;
  message: string | null;
}
interface Invite {
  email: string;
  name: string;
  link: string | null;
  outcome: string;
  message: string | null;
}
export interface ImportRun {
  id: string;
  sourceUrl: string;
  orgName: string | null;
  actor: string;
  status: string;
  created: number;
  skipped: number;
  failed: number;
  manual: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

type StepId = "connect" | "destination" | "review" | "import" | "done";

const STEPS: WizardStep<StepId>[] = [
  { id: "connect", label: "Connect" },
  { id: "destination", label: "Destination" },
  { id: "review", label: "Review" },
  { id: "import", label: "Import" },
  { id: "done", label: "Done" },
];

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
    $skipDatabases: Boolean
  ) {
    importDokployProject(
      input: $input
      runId: $runId
      projectId: $projectId
      servers: $servers
      skipDatabases: $skipDatabases
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

/* ------------------------------------------------------------------ */
/* Component                                                          */
/* ------------------------------------------------------------------ */

export function ImportWizard({
  teamName,
  servers,
  runs,
  isInstanceAdmin,
}: {
  teamName: string;
  servers: { id: string; name: string; type: string }[];
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
  const [chosen, setChosen] = React.useState<Set<string>>(new Set());
  const [skipDatabases, setSkipDatabases] = React.useState(false);

  const [newTeam, setNewTeam] = React.useState("");
  const [creatingTeam, setCreatingTeam] = React.useState(false);

  const [progress, setProgress] = React.useState({ done: 0, total: 0, current: "" });
  const [items, setItems] = React.useState<ReportItem[]>([]);
  const [runId, setRunId] = React.useState<string | null>(null);
  const [failure, setFailure] = React.useState<string | null>(null);

  const [invites, setInvites] = React.useState<Invite[] | null>(null);
  const [inviting, setInviting] = React.useState(false);

  const connectInput = React.useMemo(
    () => ({ url, apiKey, allowPrivate: sameMachine }),
    [url, apiKey, sameMachine],
  );

  const done: Record<StepId, boolean> = {
    connect: plan != null,
    destination: plan != null,
    review: chosen.size > 0,
    import: items.length > 0,
    done: false,
  };

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
    // Everything importable is picked by default; a project already here is not,
    // since re-importing it would only produce a page of "already here" rows.
    setChosen(
      new Set(scanned.projects.filter((p) => !p.exists).map((p) => p.sourceId)),
    );
    // One server in the fleet is the answer to every mapping question.
    if (servers.length === 1) {
      const only = servers[0].id;
      setServerMap(
        Object.fromEntries([
          [OWN_HOST, only],
          ...scanned.servers.map((s) => [s.sourceId, only]),
        ]),
      );
    }
    setStep("destination");
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

  /* ---- step 4: import ---------------------------------------------- */

  async function runImport() {
    if (!plan) return;
    const targets = plan.projects.filter((p) => chosen.has(p.sourceId));
    setItems([]);
    setFailure(null);
    setProgress({ done: 0, total: targets.length, current: targets[0]?.name ?? "" });
    setStep("import");

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

    for (const [i, project] of targets.entries()) {
      setProgress({ done: i, total: targets.length, current: project.name });
      const res = await gqlAction<
        { importDokployProject: { items: ReportItem[] } },
        { items: ReportItem[] }
      >(
        IMPORT_PROJECT,
        {
          input: connectInput,
          runId: openRunId,
          projectId: project.sourceId,
          servers: serverChoices,
          skipDatabases,
        },
        (d) => d.importDokployProject,
      );
      if (!res.ok) {
        setFailure(res.error);
        return;
      }
      const landed = res.data?.items ?? [];
      setItems((prev) => [...prev, ...landed]);
    }

    setProgress({ done: targets.length, total: targets.length, current: "" });
    await gqlAction(FINISH, { runId: openRunId });
    setStep("done");
    router.refresh();
  }

  /* ---- step 5: members --------------------------------------------- */

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
        reachable={(s) =>
          STEPS.slice(0, STEPS.findIndex((x) => x.id === s)).every((p) => done[p.id])
        }
        onSelect={(s) => {
          // The import is not a step you can walk back into while it runs, and
          // the last two are not steps you can walk FORWARD into: they are what
          // the Import button produces, and an empty progress bar with nothing
          // behind it is worse than a chip that does not respond.
          if (step === "import" && progress.done < progress.total) return;
          if ((s === "import" || s === "done") && items.length === 0) return;
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
          onSubmit={scan}
          runs={runs}
        />
      )}

      {step === "destination" && plan && (
        <DestinationStep
          plan={plan}
          teamName={teamName}
          servers={servers}
          serverMap={serverMap}
          setServerMap={setServerMap}
          skipDatabases={skipDatabases}
          setSkipDatabases={setSkipDatabases}
          isInstanceAdmin={isInstanceAdmin}
          newTeam={newTeam}
          setNewTeam={setNewTeam}
          creatingTeam={creatingTeam}
          onCreateTeam={createTeamAndSwitch}
          onBack={() => setStep("connect")}
          onNext={() => setStep("review")}
        />
      )}

      {step === "review" && plan && (
        <ReviewStep
          plan={plan}
          chosen={chosen}
          setChosen={setChosen}
          teamName={teamName}
          onBack={() => setStep("destination")}
          onStart={runImport}
        />
      )}

      {step === "import" && (
        <ImportStep progress={progress} items={items} failure={failure} />
      )}

      {step === "done" && (
        <DoneStep
          items={items}
          plan={plan}
          isInstanceAdmin={isInstanceAdmin}
          invites={invites}
          inviting={inviting}
          onInvite={inviteMembers}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 1 — connect                                                   */
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
  onSubmit,
  runs,
}: {
  url: string;
  setUrl: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  sameMachine: boolean;
  setSameMachine: (v: boolean) => void;
  canUsePrivate: boolean;
  scanning: boolean;
  onSubmit: (e: React.FormEvent) => void;
  runs: ImportRun[];
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
                {scanning ? "Reading Dokploy" : "Continue"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {runs.length > 0 && <PastRuns runs={runs} />}
    </div>
  );
}

function PastRuns({ runs }: { runs: ImportRun[] }) {
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
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Step 2 — destination                                               */
/* ------------------------------------------------------------------ */

function DestinationStep({
  plan,
  teamName,
  servers,
  serverMap,
  setServerMap,
  skipDatabases,
  setSkipDatabases,
  isInstanceAdmin,
  newTeam,
  setNewTeam,
  creatingTeam,
  onCreateTeam,
  onBack,
  onNext,
}: {
  plan: Plan;
  teamName: string;
  servers: { id: string; name: string; type: string }[];
  serverMap: Record<string, string>;
  setServerMap: (v: Record<string, string>) => void;
  skipDatabases: boolean;
  setSkipDatabases: (v: boolean) => void;
  isInstanceAdmin: boolean;
  newTeam: string;
  setNewTeam: (v: string) => void;
  creatingTeam: boolean;
  onCreateTeam: (e: React.FormEvent) => void;
  onBack: () => void;
  onNext: () => void;
}) {
  // Dokploy's own host is always a source, whether or not it has a server row.
  const sources = [
    { sourceId: OWN_HOST, name: "The Dokploy host", ipAddress: null as string | null },
    ...plan.servers,
  ];
  const ready = sources.every((s) => serverMap[s.sourceId]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Where it lands</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            {plan.orgName
              ? `The Dokploy organization ${plan.orgName} goes into the team ${teamName}.`
              : `Everything goes into the team ${teamName}.`}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border p-3 text-sm text-muted-foreground">
            To import somewhere else, switch team in the topbar first.
            {isInstanceAdmin && " Or start a new team for it:"}
          </div>

          {isInstanceAdmin && (
            <form className="flex flex-wrap items-center gap-2" onSubmit={onCreateTeam}>
              <Input
                value={newTeam}
                onChange={(e) => setNewTeam(e.target.value)}
                placeholder={plan.orgName ?? "New team name"}
                className="max-w-xs"
              />
              <Button type="submit" variant="outline" disabled={creatingTeam || !newTeam.trim()}>
                Create team
              </Button>
            </form>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Servers</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Pick which of your servers takes each of Dokploy&apos;s.
          </p>
        </CardHeader>
        <CardContent className="space-y-3">
          {servers.length === 0 ? (
            <EmptyState
              icon={ServerIcon}
              title="No server to deploy to"
              description="Add a server under Settings, Servers before importing."
            />
          ) : (
            sources.map((s) => (
              <div
                key={s.sourceId || "own"}
                className="flex flex-wrap items-center justify-between gap-3"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{s.name}</div>
                  {s.ipAddress && (
                    <p className="mt-1 text-xs text-muted-foreground">{s.ipAddress}</p>
                  )}
                </div>
                <Select
                  value={serverMap[s.sourceId] ?? ""}
                  onValueChange={(v) =>
                    setServerMap({ ...serverMap, [s.sourceId]: v })
                  }
                >
                  <SelectTrigger className="w-64">
                    <SelectValue placeholder="Choose a server" />
                  </SelectTrigger>
                  <SelectContent>
                    {servers.map((t) => (
                      <SelectItem key={t.id} value={t.id}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Databases</CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            A database is the one thing an import really starts: Deplo brings the
            container up empty, ready for your dump.
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <FieldLabel htmlFor="skip-databases">Leave the databases out</FieldLabel>
              <p className="mt-1 text-sm text-muted-foreground">
                They are listed in the report instead, to create when you are ready.
              </p>
            </div>
            <Switch
              id="skip-databases"
              checked={skipDatabases}
              onCheckedChange={setSkipDatabases}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={!ready}>
          Continue
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 3 — review                                                    */
/* ------------------------------------------------------------------ */

const STATUS_LABEL: Record<PlanService["status"], string> = {
  new: "New",
  exists: "Already here",
  unsupported: "Not supported",
  needs_grant: "Needs a permission",
};

function ReviewStep({
  plan,
  chosen,
  setChosen,
  teamName,
  onBack,
  onStart,
}: {
  plan: Plan;
  chosen: Set<string>;
  setChosen: (v: Set<string>) => void;
  teamName: string;
  onBack: () => void;
  onStart: () => void;
}) {
  const allChosen = chosen.size === plan.projects.length;

  function toggle(sourceId: string) {
    const next = new Set(chosen);
    if (next.has(sourceId)) next.delete(sourceId);
    else next.add(sourceId);
    setChosen(next);
  }

  const counts = React.useMemo(() => {
    let apps = 0;
    let databases = 0;
    let attention = 0;
    for (const p of plan.projects) {
      if (!chosen.has(p.sourceId)) continue;
      for (const e of p.environments)
        for (const s of e.services) {
          if (s.targetKind === "app") apps++;
          if (s.targetKind === "database") databases++;
          if (s.notes.length > 0) attention++;
        }
    }
    return { apps, databases, attention };
  }, [plan, chosen]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <CardTitle>What will come over</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {counts.apps} app(s) and {counts.databases} database(s) into {teamName}.
              Nothing is deployed - Dokploy keeps serving until you say otherwise.
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setChosen(
                allChosen ? new Set() : new Set(plan.projects.map((p) => p.sourceId)),
              )
            }
          >
            {allChosen ? "Unselect all" : "Select all"}
          </Button>
        </CardHeader>
        <CardContent className="space-y-3">
          {plan.projects.length === 0 && (
            <EmptyState
              icon={Layers}
              title="Nothing to import"
              description="That Dokploy organization has no projects, or the key cannot see them."
            />
          )}
          {plan.projects.map((p) => (
            <div key={p.sourceId} className="rounded-lg border">
              <div className="flex items-center gap-3 border-b p-3">
                <Checkbox
                  id={`p-${p.sourceId}`}
                  checked={chosen.has(p.sourceId)}
                  onCheckedChange={() => toggle(p.sourceId)}
                />
                <label htmlFor={`p-${p.sourceId}`} className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{p.name}</span>
                  {p.exists && (
                    <Badge variant="outline" className="ml-2">
                      Already here
                    </Badge>
                  )}
                </label>
              </div>
              <div className="divide-y">
                {p.environments.map((e) => (
                  <div key={e.sourceId} className="p-3">
                    <div className="text-xs uppercase tracking-wide text-muted-foreground">
                      {e.name}
                    </div>
                    <div className="mt-2 space-y-2">
                      {e.services.length === 0 && (
                        <p className="text-sm text-muted-foreground">Nothing in here.</p>
                      )}
                      {e.services.map((s) => (
                        <ServiceRow key={s.sourceId} service={s} />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {counts.attention > 0 && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            {counts.attention} thing(s) need a look after the import. They are listed
            under each service above, and again in the report at the end.
          </p>
        </div>
      )}

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onStart} disabled={chosen.size === 0}>
          Import
        </Button>
      </div>
    </div>
  );
}

function ServiceRow({ service }: { service: PlanService }) {
  const Icon = service.targetKind === "database" ? Database : Layers;
  return (
    <div className="rounded-md bg-muted/40 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Icon className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{service.name}</span>
        <span className="text-xs text-muted-foreground">{service.kind}</span>
        <Badge
          variant={
            service.status === "new"
              ? "secondary"
              : service.status === "exists"
                ? "outline"
                : "destructive"
          }
        >
          {STATUS_LABEL[service.status]}
        </Badge>
        {service.domains.map((d) => (
          <span key={d} className="text-xs text-muted-foreground">
            {d}
          </span>
        ))}
      </div>
      {service.notes.length > 0 && (
        <ul className="mt-1 space-y-1">
          {service.notes.map((n, i) => (
            <li key={i} className="text-xs text-muted-foreground">
              {n}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Step 4 — import                                                    */
/* ------------------------------------------------------------------ */

function ImportStep({
  progress,
  items,
  failure,
}: {
  progress: { done: number; total: number; current: string };
  items: ReportItem[];
  failure: string | null;
}) {
  const pct = progress.total === 0 ? 0 : (progress.done / progress.total) * 100;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          {failure ? "Import stopped" : progress.current || "Finishing"}
        </CardTitle>
        <p className="mt-1 text-sm text-muted-foreground">
          {failure
            ? failure
            : `Project ${Math.min(progress.done + 1, progress.total)} of ${progress.total}.`}
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        <Progress value={pct} />
        <div className="max-h-80 space-y-1 overflow-y-auto">
          {items.map((i, n) => (
            <ItemLine key={n} item={i} />
          ))}
        </div>
        {failure && (
          <p className="text-sm text-muted-foreground">
            Everything created so far is kept. Running the import again resumes from
            here - whatever is already in Deplo is skipped.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Step 5 — done                                                      */
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
  plan,
  isInstanceAdmin,
  invites,
  inviting,
  onInvite,
}: {
  items: ReportItem[];
  plan: Plan | null;
  isInstanceAdmin: boolean;
  invites: Invite[] | null;
  inviting: boolean;
  onInvite: () => void;
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

  const people = (plan?.members ?? []).filter((m) => !m.inTeam);

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

      {isInstanceAdmin && people.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>People</CardTitle>
            <p className="mt-1 text-sm text-muted-foreground">
              {people.length} person(s) were in that Dokploy organization. Passwords
              cannot be moved, so everyone gets a single-use link to create their
              account - and joins as a plain member whatever they were over there.
            </p>
          </CardHeader>
          <CardContent className="space-y-2">
            {invites == null ? (
              <Button onClick={onInvite} disabled={inviting}>
                <Users className="size-4" />
                {inviting ? "Creating links" : "Create their links"}
              </Button>
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
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* One report line                                                    */
/* ------------------------------------------------------------------ */

const OUTCOME_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  created: Check,
  skipped: SkipForward,
  failed: AlertTriangle,
  manual: DownloadCloud,
  unsupported: CircleSlash,
};

function ItemLine({ item }: { item: ReportItem }) {
  const Icon = OUTCOME_ICON[item.outcome] ?? Lock;
  return (
    <div className="flex items-start gap-2 text-sm">
      <Icon
        className={cn(
          "mt-0.5 size-3.5 shrink-0",
          item.outcome === "created"
            ? "text-primary"
            : item.outcome === "failed"
              ? "text-destructive"
              : "text-muted-foreground",
        )}
      />
      <div className="min-w-0">
        <span className="text-muted-foreground">{item.path}</span>
        {item.message && <span className="ml-2">{item.message}</span>}
      </div>
    </div>
  );
}
