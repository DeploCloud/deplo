"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Globe, Loader2, Pencil, TriangleAlert } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { ConsentShell } from "@/components/oauth/consent-shell";
import { PermissionPicker } from "@/components/settings/permission-picker";
import {
  ScopePicker,
  type ScopeSelection,
} from "@/components/settings/tokens/scope-picker";
import { gqlAction } from "@/lib/graphql-client";
import { scopeLabel } from "@/components/settings/tokens/scope-label";
import { TOKEN_PRESETS, presetIdFor } from "@/lib/token-presets";
import type { Capability } from "@/lib/types";
import type { ScopeTreeTeam } from "@/lib/data/tokens";
import type { ConsentClientDTO } from "@/lib/data/mcp-clients";

const AUTHORIZE = /* GraphQL */ `
  mutation (
    $clientId: String!
    $capabilities: [String!]
    $teamIds: [String!]
    $projectIds: [String!]
    $folderIds: [String!]
    $appIds: [String!]
    $expectedTeamId: String
  ) {
    authorizeMcpClient(
      clientId: $clientId
      capabilities: $capabilities
      teamIds: $teamIds
      projectIds: $projectIds
      folderIds: $folderIds
      appIds: $appIds
      expectedTeamId: $expectedTeamId
    )
  }
`;

/**
 * Finish the OAuth handshake from the BROWSER.
 *
 * It cannot be done server-side: `/api/auth/oauth2/consent` funnels into the
 * provider's `authorizeEndpoint`, which opens with
 * `if (!ctx.request) throw UNAUTHORIZED("request not found")`, and an in-process
 * `auth.api.*` call has no request. Same-origin, so the CSP's `connect-src
 * 'self'` allows it and the browser attaches both the session cookie and the
 * `Origin` header the endpoint's CSRF check wants.
 *
 * The endpoint answers with JSON, not a 302, so there is no redirect to follow —
 * we read the URL and navigate. Its refusals live in `error_description`, and
 * `message` is empty, which is exactly how this once became an error toast with
 * nothing written in it.
 */
async function postConsent(
  body: { accept: boolean; scope?: string; oauth_query?: string },
): Promise<{ url?: string; error?: string }> {
  try {
    const res = await fetch("/api/auth/oauth2/consent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as {
      url?: string;
      error_description?: string;
      message?: string;
    };
    if (!res.ok || !json.url)
      return {
        error:
          json.error_description ||
          json.message ||
          `deplo could not finish the connection (${res.status})`,
      };
    return { url: json.url };
  } catch {
    return { error: "deplo could not reach its own sign-in service" };
  }
}

/**
 * The consent screen's form. Approving it MINTS an API token, which is why it
 * is the token editor's controls rather than a yes/no button: the person is
 * choosing what a third party may do inside their team, and a screen that only
 * says "Allow" cannot tell them.
 *
 * Defaults to the "MCP & AI agents" preset — written for this threat model, and
 * the reason this is one click for anyone who does not want to think about it.
 */
export function ConsentForm({
  client,
  scope,
  oauthQuery,
  tree,
  activeTeamId,
  connectableTeamIds,
  publicOrigin,
  username,
}: {
  client: ConsentClientDTO;
  scope: string;
  oauthQuery: string;
  tree: ScopeTreeTeam[];
  /** The team the mint will actually use — the dropdown must start here. */
  activeTeamId: string;
  /**
   * The teams the mint would accept, ticked to begin with.
   *
   * Starting empty meant the screen never said where the app was going: the
   * rule it relied on ("nothing ticked is the team you came from") is invisible,
   * and untickable in the direction that matters. Starting on every team the
   * person may grant makes the reach readable, and narrowing it is unticking.
   */
  connectableTeamIds: string[];
  /** The origin deplo publishes, which the consent POST must come from. */
  publicOrigin: string | null;
  /** Whose account the minted token will act as — worth saying before the click. */
  username: string;
}) {
  const router = useRouter();
  const mcpPreset = TOKEN_PRESETS.find((p) => p.id === "mcp");
  const [capabilities, setCapabilities] = useState<Capability[]>(
    mcpPreset?.capabilities ?? ["view"],
  );
  const [selection, setSelection] = useState<ScopeSelection>({
    teamIds: connectableTeamIds,
    projectIds: [],
    folderIds: [],
    appIds: [],
  });
  // Which half of "what it gets" is being edited. Two dialogs, not one: the row
  // you press is the question you wanted to answer, and answering the other one
  // was never the reason you clicked.
  const [editing, setEditing] = useState<null | "access" | "permissions">(null);
  // The team this connection is being made FROM. Always granted (the server
  // includes it whatever the picker says) and the default when nothing is
  // ticked. Not a control any more — the picker is the only one.
  const connectingTeam = tree.find((t) => t.id === activeTeamId);

  // Better Auth refuses a cookie-carrying POST whose Origin is not the address
  // deplo publishes — the CSRF defence the consent posts through. On an instance
  // reachable at a second address that refusal is correct and completely
  // baffling, so say it before the click rather than after.
  const wrongOrigin =
    typeof window !== "undefined" &&
    !!publicOrigin &&
    window.location.origin !== publicOrigin;

  const [pending, setPending] = useState(false);
  const presetId = useMemo(() => presetIdFor(capabilities), [capabilities]);
  const preset = TOKEN_PRESETS.find((p) => p.id === presetId);

  const scoped =
    selection.teamIds.length +
      selection.projectIds.length +
      selection.folderIds.length +
      selection.appIds.length >
    0;
  // Named where we can name it: one ticked team reads "Idra Arts", not
  // "1 team". Teams only — a mixed selection is honestly a count, and the
  // deeper nodes are what the Advanced screen is for.
  const teamNames = useMemo(
    () => Object.fromEntries(tree.map((t) => [t.id, t.name])),
    [tree],
  );
  // "Access" is what this repo calls a token's reach and "Permissions" what it
  // calls its capabilities (token-editor.tsx's own summary rows) — same words
  // here, so the two screens do not name one thing twice.
  const accessLabel = scoped
    ? scopeLabel({ scoped: true, ...selection }, teamNames)
    : { text: connectingTeam?.name ?? "This team", empty: false };
  // A team wears its initials everywhere else in deplo (the team switcher), so
  // it wears them here too — the reach of a connection is the one place a name
  // in plain text is easiest to skim past. Only when teams are what is ticked:
  // stamping the connecting team's badge next to "2 folders" would say the
  // connection reaches all of it.
  const accessTeams = (
    selection.teamIds.length ? selection.teamIds : scoped ? [] : [activeTeamId]
  )
    .map((id) => tree.find((t) => t.id === id))
    .filter((t): t is ScopeTreeTeam => !!t)
    .slice(0, 3);

  /**
   * Consent FIRST, mint second, navigate last.
   *
   * The order is the security property. `POST /oauth2/consent` verifies the
   * provider's signature over the authorization query and only then records the
   * approval, so the mint that follows can require that record and refuse to
   * create a credential for anyone who merely got a person onto this page with
   * a chosen `client_id`. Minting first answered to a URL.
   *
   * The code the consent hands back is not redeemable until the browser
   * navigates, which is the last thing here — so the window in which a code
   * exists without a connection behind it is this function, and a failure in it
   * leaves a visible error rather than a working credential.
   *
   * `gqlAction`, not `useGraphqlMutation`: the latter's `error` is React state,
   * so reading it straight after the await gets the value from BEFORE the
   * failure — the server's refusal would be swallowed and the button would look
   * inert. Every path below ends in either a navigation or a message; none ends
   * in silence.
   */
  async function onApprove(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    const done = await postConsent({
      accept: true,
      ...(scope ? { scope } : {}),
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    });
    if (!done.url) {
      setPending(false);
      toast.error(done.error || "deplo could not finish the connection");
      return;
    }
    const minted = await gqlAction(AUTHORIZE, {
      clientId: client.clientId,
      capabilities,
      teamIds: selection.teamIds,
      projectIds: selection.projectIds,
      folderIds: selection.folderIds,
      appIds: selection.appIds,
      // What this screen is showing. The server decides the team; this only
      // lets it refuse when the two have drifted apart.
      expectedTeamId: activeTeamId,
    });
    if (!minted.ok) {
      setPending(false);
      toast.error(minted.error || "deplo refused the connection");
      return;
    }
    // A full-page navigation, not router.push: the destination is the client's
    // own site.
    window.location.assign(done.url);
  }

  /**
   * Signed in as the wrong person — the one thing this screen can be right
   * about and still be wrong, because the token it mints acts as whoever is
   * looking at it.
   *
   * Back to THIS url after signing in, not to the dashboard: `safeNext` on the
   * login page allows `/oauth/consent?…` for exactly this reason, and losing
   * the query strands someone mid-flow inside a third-party product.
   *
   * `push` then `refresh`, the same pair the account menu logs out with — the
   * session cookie has just changed, and the RSC tree cached behind it was
   * rendered for the person who is no longer signed in.
   */
  async function onSwitchAccount() {
    setPending(true);
    await gqlAction(`mutation { logout }`, {});
    const here = window.location.pathname + window.location.search;
    router.push(`/login?next=${encodeURIComponent(here)}`);
    router.refresh();
  }

  async function onDeny() {
    setPending(true);
    const done = await postConsent({
      accept: false,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    });
    window.location.assign(done.url ?? "/settings/mcp");
  }

  return (
    <ConsentShell>
      {wrongOrigin ? (
        <p className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-muted-foreground">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <span>
            You opened deplo at a different address from the one it publishes (
            {publicOrigin}). Approving will be refused. Open deplo at that
            address and start the connection again.
          </span>
        </p>
      ) : null}

      <Card>
        {/* One column, centred: the app asking, then the two lines that say
            what it gets, then the choice. Everything else is behind a row. */}
        <form className="grid gap-6 p-6" onSubmit={onApprove}>
          <div className="grid justify-items-center gap-4 text-center">
            {/* Remote icons never render — the CSP is `img-src 'self' blob:
                data:` — so this is initials for almost every client, and the
                `src` is here for the rare `data:` one. Radix falls back on the
                blocked load by itself. */}
            <Avatar className="size-14">
              <AvatarImage src={client.icon ?? undefined} alt="" />
              <AvatarFallback className="bg-muted text-base font-semibold">
                {client.name.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">
                Connect {client.name} to deplo
              </h1>
              {client.redirectOrigin ? (
                <p className="mt-1 flex items-center justify-center gap-1.5 text-sm text-muted-foreground">
                  <Globe className="size-3.5 shrink-0" />
                  <span className="truncate">{client.redirectOrigin}</span>
                  <InfoTip content="Where deplo sends it back after you approve. It is the one thing this app cannot make up about itself." />
                </p>
              ) : (
                <p className="mt-1 text-sm text-muted-foreground">
                  Give it only what it needs.
                </p>
              )}
            </div>
          </div>

          <div className="grid gap-2">
            <FieldLabel info="What the app may do, and what it may reach. It can never do more than you can.">
              What it gets
            </FieldLabel>
            {/* One row, one dialog: press the half of the sentence you want to
                change and that is the only thing you are asked about. */}
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border text-sm">
              <SummaryRow
                label="Access"
                onClick={() => setEditing("access")}
                disabled={pending}
              >
                {accessTeams.length ? (
                  <span className="flex -space-x-1.5">
                    {accessTeams.map((t) => (
                      <Avatar key={t.id} className="size-6 border-2 border-card">
                        <AvatarFallback className="bg-foreground text-[9px] text-background">
                          {t.name.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    ))}
                  </span>
                ) : null}
                <span className="truncate font-medium">{accessLabel.text}</span>
              </SummaryRow>
              <SummaryRow
                label="Permissions"
                onClick={() => setEditing("permissions")}
                disabled={pending}
              >
                <span className="truncate font-medium">
                  {preset ? preset.name : `${capabilities.length} selected`}
                </span>
              </SummaryRow>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Button
              type="button"
              variant="outline"
              onClick={onDeny}
              disabled={pending}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : null}
              Authorize
            </Button>
          </div>
        </form>
      </Card>

      <p className="mt-4 text-center text-xs text-muted-foreground">
        Connecting as {username} · Not you?{" "}
        <button
          type="button"
          onClick={() => void onSwitchAccount()}
          disabled={pending}
          className="cursor-pointer font-medium underline underline-offset-2 transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-60"
        >
          Log out
        </button>
      </p>

      {/* Where the app may work, opened on demand so the default path is reading
          two lines and pressing Authorize. Its own dialog, because narrowing the
          reach and picking what may be done there are two decisions, and the row
          you pressed said which one you came for. */}
      <Dialog
        open={editing === "access"}
        onOpenChange={(open) => setEditing(open ? "access" : null)}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            {/* Not titled "Access": the picker below brings its own heading, and
                the word printed twice one line apart reads as a bug. */}
            <DialogTitle>What {client.name} can reach</DialogTitle>
            <DialogDescription className="mt-1">
              Every team you can connect is ticked. Untick what it should not
              reach.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
            }}
          >
            {/* ONE control for "where". A separate team dropdown next to it was
                the contradiction that let a connection be approved for one team
                and granted four: two controls both answering "which team", free
                to disagree. */}
            <ScopePicker
              tree={tree}
              selection={selection}
              onChange={setSelection}
              info="Which teams this app may work in, and how much of each. Every team you can connect is ticked to begin with - untick the ones it should not reach, or narrow one to a project, folder or app."
            />

            <DialogFooter>
              <Button type="submit">Done</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* What it may do once it is in there. */}
      <Dialog
        open={editing === "permissions"}
        onOpenChange={(open) => setEditing(open ? "permissions" : null)}
      >
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>What {client.name} may do</DialogTitle>
            <DialogDescription className="mt-1">
              Start from a template, then tick exactly what it needs.
            </DialogDescription>
          </DialogHeader>
          <form
            className="grid gap-6"
            onSubmit={(e) => {
              e.preventDefault();
              setEditing(null);
            }}
          >
            <div className="grid gap-3">
              <div className="grid gap-2">
                <FieldLabel
                  htmlFor="consent-preset"
                  info="A starting set you can then adjust. Custom appears once the ticks stop matching one."
                >
                  Template
                </FieldLabel>
                <Select
                  value={presetId ?? CUSTOM}
                  onValueChange={(id) => {
                    const next = TOKEN_PRESETS.find((p) => p.id === id);
                    if (next) setCapabilities(next.capabilities);
                  }}
                >
                  <SelectTrigger id="consent-preset" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TOKEN_PRESETS.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                    {presetId ? null : (
                      <SelectItem value={CUSTOM} disabled>
                        Custom
                      </SelectItem>
                    )}
                  </SelectContent>
                </Select>
                {preset ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {preset.description}
                  </p>
                ) : null}
              </div>
              {/* Bounded and scrolled, like the scope tree next door: forty-odd
                  permissions growing the dialog past its own cap put Done below
                  the fold, reachable only by scrolling the whole modal. */}
              <PermissionPicker
                capabilities={capabilities}
                onChange={setCapabilities}
                scroll
                hint="Tick exactly what this app should be able to do. A secret can never be read over MCP, whatever is ticked here."
              />
            </div>

            <DialogFooter>
              <Button type="submit">Done</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </ConsentShell>
  );
}

/** Radix needs a value for the "matches no preset" state; it is never chosen. */
const CUSTOM = "custom";

/** One line of the summary — a label, what it currently says, and a way in. */
function SummaryRow({
  label,
  children,
  onClick,
  disabled,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={`Change ${label.toLowerCase()}`}
      className="flex w-full cursor-pointer items-center gap-3 p-3 text-left transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-60"
    >
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="ml-auto flex min-w-0 items-center gap-2">{children}</span>
      <Pencil className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
