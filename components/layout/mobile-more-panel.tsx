"use client";

import * as React from "react";
import { Check, Fingerprint, KeyRound, Moon, Plus } from "lucide-react";
import Link from "@/components/ui/link";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { CreateTeamDialog } from "@/components/teams/create-team-dialog";
import { useTheme } from "@/components/theme-provider";
import { useFlatPathname, useRouter } from "@/lib/nav";
import { teamSwitchDestination } from "@/lib/team-switch";
import { withTeam } from "@/lib/team-path";
import { NAV } from "./nav-config/main-nav";
import { MOBILE_TABS } from "./nav-config/mobile-tabs";
import { canSee } from "./nav-config/nav-item";
import { SETTINGS_NAV } from "./nav-config/settings-nav";
import { useNavSections } from "./use-nav-sections";
import {
  Card,
  Label,
  NavRow,
  PhoneRow,
  Row,
  RowIcon,
  Text,
} from "./mobile-rows";
import { PhoneRows } from "./mobile-phone-section";
import type { PublicUser } from "@/lib/types/identity";
import type { TeamIdentity, TeamSummary } from "@/lib/types/team";

const IN_PILL = new Set(MOBILE_TABS.map((t) => t.href));

// Everything the pill has no room for: account, teams, the other sections and settings.
export function MobileMorePanel({
  user,
  team,
  teams,
  capabilities,
  isAdmin,
  hasSecondFactor,
  onClose,
}: {
  user: PublicUser;
  team: TeamIdentity;
  teams: TeamSummary[];
  capabilities: string[];
  isAdmin: boolean;
  hasSecondFactor: boolean;
  onClose: () => void;
}) {
  const pathname = useFlatPathname();
  const router = useRouter();
  const { resolvedTheme, setTheme } = useTheme();
  const [createOpen, setCreateOpen] = React.useState(false);
  const caps = new Set(capabilities);
  const here = useNavSections(capabilities, isAdmin);
  const inService = here.menu === "service" || here.menu === "service-settings";

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const root = document.documentElement;
    const prev = root.style.overflow;
    root.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  function switchTo(target: TeamSummary) {
    if (target.id === team.id) return onClose();
    router.replace(withTeam(teamSwitchDestination(pathname), target.slug));
  }

  const workspace = NAV.flatMap((s) => s.items).filter(
    (i) => !IN_PILL.has(i.href) && canSee(i, caps, isAdmin),
  );
  const settings = SETTINGS_NAV.filter(
    (s) => !s.backLink && s.title !== "Account",
  )
    .map((s) => ({
      title: s.title === "Team" ? "Team settings" : s.title,
      items: s.items.filter((i) => canSee(i, caps, isAdmin)),
    }))
    .filter((s) => s.items.length > 0);

  return (
    <nav
      aria-label="More"
      className="fixed inset-x-0 top-14 bottom-0 z-[35] overflow-y-auto overscroll-contain bg-background px-4 pb-[calc(max(12px,env(safe-area-inset-bottom))+96px)] md:hidden"
    >
      <h1 className="mt-5 text-[26px] leading-tight font-semibold tracking-tight">
        More
      </h1>

      <Card className="mt-4">
        <Row href="/settings/account" onClick={onClose}>
          <UserAvatar
            name={user.name}
            username={user.username}
            avatarUrl={user.avatarUrl}
            size="xl"
          />
          <Text title={user.name || user.username} sub={`@${user.username}`} />
        </Row>
        <Row href="/settings/security" onClick={onClose}>
          <RowIcon icon={Fingerprint} />
          <Text title="Security" />
          {!hasSecondFactor && <Badge variant="warning">2FA off</Badge>}
        </Row>
        <Row href="/settings/tokens" onClick={onClose}>
          <RowIcon icon={KeyRound} />
          <Text title="API tokens" />
        </Row>
      </Card>

      {inService && (
        <>
          <Label>{here.appSlug ? "This app" : "This database"}</Label>
          <Card>
            {here.sections
              .filter((sec) => !sec.backLink)
              .flatMap((sec) => sec.items)
              .map((i) => (
                <NavRow key={i.href} item={i} onClick={onClose} />
              ))}
          </Card>
        </>
      )}

      <Label>Team</Label>
      <Card>
        {teams.map((t) => (
          <Row key={t.id} onClick={() => switchTo(t)}>
            <TeamAvatar name={t.name} avatarUrl={t.avatarUrl} size="lg" />
            <Text
              title={t.name}
              sub={`${t.memberCount} ${t.memberCount === 1 ? "member" : "members"}`}
            />
            {t.id === team.id && <Check className="size-5 shrink-0" />}
          </Row>
        ))}
        <Row onClick={() => setCreateOpen(true)}>
          <RowIcon icon={Plus} />
          <Text title="Create team" />
        </Row>
      </Card>

      {workspace.length > 0 && (
        <>
          <Label>Workspace</Label>
          <div className="grid grid-cols-2 gap-2.5">
            {workspace.map((i) => (
              <Link
                key={i.href}
                href={i.href}
                onClick={onClose}
                className="flex h-14 items-center gap-2.5 rounded-lg border border-border bg-card px-3.5 font-medium"
              >
                <i.icon className="size-[19px] shrink-0 text-muted-foreground" />
                <span className="truncate">{i.label}</span>
              </Link>
            ))}
          </div>
        </>
      )}

      {settings.map((s) => (
        <React.Fragment key={s.title}>
          <Label>{s.title}</Label>
          <Card>
            {s.items.map((i) => (
              <NavRow key={i.href} item={i} onClick={onClose} />
            ))}
          </Card>
        </React.Fragment>
      ))}

      <Label>This phone</Label>
      <Card>
        <PhoneRows
          team={team}
          canManageAlerts={caps.has("manage_notifications")}
          Row={PhoneRow}
        />
      </Card>

      <Label>Appearance</Label>
      <Card>
        <label className="flex min-h-14 cursor-pointer items-center gap-3 px-3.5 py-2.5">
          <RowIcon icon={Moon} />
          <Text title="Dark mode" />
          <Switch
            checked={resolvedTheme === "dark"}
            onCheckedChange={(on) => setTheme(on ? "dark" : "light")}
          />
        </label>
      </Card>

      <CreateTeamDialog open={createOpen} onOpenChange={setCreateOpen} />
    </nav>
  );
}
