import { ShieldCheck, Lock, KeyRound, Users } from "lucide-react";
import { getCurrentUser } from "@/lib/auth";
import { read } from "@/lib/store";
import { listTokens } from "@/lib/data/tokens";
import { getNotificationSettings } from "@/lib/data/notifications";
import { DEPLO_VERSION } from "@/lib/version";
import { PageHeader } from "@/components/shared/page-header";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { ThemeToggle } from "@/components/layout/theme-toggle";
import { TokensPanel } from "@/components/settings/tokens-panel";
import { TeamForm } from "@/components/settings/team-form";
import { NotificationsPanel } from "@/components/settings/notifications-panel";
import { UpdateCard } from "@/components/settings/update-card";
import { RegistriesPanel } from "@/components/settings/registries-panel";
import { listRegistries } from "@/lib/data/registries";
import { GithubPanel } from "@/components/settings/github-panel";
import { listGithubApps } from "@/lib/data/github";

export const metadata = { title: "Settings" };

const TABS = [
  "general",
  "members",
  "tokens",
  "notifications",
  "registries",
  "git",
  "security",
];

export default async function SettingsPage(props: PageProps<"/settings">) {
  const sp = await props.searchParams;
  const tabParam = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const defaultTab = tabParam && TABS.includes(tabParam) ? tabParam : "general";
  const gitStatus = Array.isArray(sp.git) ? sp.git[0] : sp.git;

  const user = await getCurrentUser();
  const data = read();
  const team = data.teams[0];
  const tokens = await listTokens();
  const members = data.users;
  const notifications = await getNotificationSettings();
  const registries = await listRegistries();
  const githubApps = await listGithubApps();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your team, members, API tokens and security."
      />

      <Tabs defaultValue={defaultTab}>
        <UnderlineTabsList>
          <UnderlineTabsTrigger value="general">General</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="members">Members</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="tokens">API Tokens</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="notifications">
            Notifications
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="registries">
            Registries
          </UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="git">Git</UnderlineTabsTrigger>
          <UnderlineTabsTrigger value="security">Security</UnderlineTabsTrigger>
        </UnderlineTabsList>

        {/* General */}
        <TabsContent value="general" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Team</CardTitle>
              <CardDescription>Your workspace details.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <TeamForm name={team.name} slug={team.slug} />
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Plan:</span>
                <Badge variant="secondary" className="capitalize">
                  {team.plan}
                </Badge>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Appearance</CardTitle>
              <CardDescription>Switch between light and dark.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex items-center justify-between rounded-lg border border-border p-3">
                <div>
                  <p className="text-sm font-medium">Theme</p>
                  <p className="text-xs text-muted-foreground">
                    Defaults to dark, matches your system if enabled.
                  </p>
                </div>
                <ThemeToggle />
              </div>
            </CardContent>
          </Card>

          <UpdateCard current={DEPLO_VERSION} />
        </TabsContent>

        {/* Members */}
        <TabsContent value="members" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Users className="size-4" />
                Members
              </CardTitle>
              <CardDescription>People with access to this team.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {members.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center justify-between rounded-lg border border-border p-3"
                >
                  <div className="flex items-center gap-3">
                    <Avatar>
                      <AvatarFallback
                        style={{ backgroundColor: m.avatarColor, color: "#000" }}
                      >
                        {m.name.slice(0, 2).toUpperCase()}
                      </AvatarFallback>
                    </Avatar>
                    <div>
                      <p className="text-sm font-medium">
                        {m.name}
                        {m.id === user?.id && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            (you)
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">{m.email}</p>
                    </div>
                  </div>
                  <Badge variant="outline" className="capitalize">
                    {m.role}
                  </Badge>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Tokens */}
        <TabsContent value="tokens">
          <TokensPanel tokens={tokens} />
        </TabsContent>

        {/* Notifications */}
        <TabsContent value="notifications">
          <NotificationsPanel initial={notifications} />
        </TabsContent>

        {/* Registries */}
        <TabsContent value="registries">
          <RegistriesPanel registries={registries} />
        </TabsContent>

        {/* Git */}
        <TabsContent value="git">
          <GithubPanel apps={githubApps} gitStatus={gitStatus} />
        </TabsContent>

        {/* Security */}
        <TabsContent value="security" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4" />
                Security posture
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <SecurityRow
                icon={<Lock className="size-4 text-[var(--success)]" />}
                title="Secrets encrypted at rest"
                detail="Env vars, DB connection strings and S3 keys are AES-256-GCM encrypted."
              />
              <SecurityRow
                icon={<KeyRound className="size-4 text-[var(--success)]" />}
                title="Session security"
                detail="HttpOnly, SameSite=Lax signed cookies. Sessions expire after 7 days."
              />
              <SecurityRow
                icon={<ShieldCheck className="size-4 text-[var(--success)]" />}
                title="Hardened headers + CSP"
                detail="Per-request nonce-based Content-Security-Policy and strict transport headers."
              />
              <p className="pt-2 text-xs text-muted-foreground">
                Set <code className="font-mono">DEPLO_SECRET</code> in production
                to rotate all derived encryption and signing keys.
              </p>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function SecurityRow({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-border p-3">
      <div className="mt-0.5">{icon}</div>
      <div>
        <p className="font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}
