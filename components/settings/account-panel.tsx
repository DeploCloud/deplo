"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ChevronRight,
  Fingerprint,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  ShieldCheck,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import { AccountGraphic } from "@/components/settings/account-graphic";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel, InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import { normalizeUsername, validateUsername } from "@/lib/username";
import { cn } from "@/lib/utils";
import type { PublicUser } from "@/lib/types";

/** The label stays mounted while the spinner runs, so the button keeps its width. */
function PendingLabel({
  pending,
  children,
}: {
  pending: boolean;
  children: React.ReactNode;
}) {
  return (
    <span className="grid place-items-center">
      <span className={cn("col-start-1 row-start-1", pending && "invisible")}>
        {children}
      </span>
      {pending && (
        <Loader2 className="col-start-1 row-start-1 size-4 animate-spin" />
      )}
    </span>
  );
}

export function AccountPanel({
  user,
  gravatar,
  passkeys,
  sessions,
}: {
  user: PublicUser;
  /** Whether the instance offers Gravatar as a picture source. */
  gravatar: boolean;
  passkeys: number;
  sessions: number;
}) {
  return (
    <div className="space-y-4">
      {/* Direct grid children, so Profile and Email share one row's height
          instead of each ending wherever its own content stops. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ProfileCard user={user} gravatar={gravatar} />
        <EmailCard user={user} />
      </div>
      <SecurityCard
        twoFactorEnabled={user.twoFactorEnabled}
        passkeys={passkeys}
        sessions={sessions}
      />
    </div>
  );
}

function ProfileCard({
  user,
  gravatar,
}: {
  user: PublicUser;
  gravatar: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(user.name);
  const [handle, setHandle] = React.useState(user.username);
  const dirty = name.trim() !== user.name || handle !== user.username;
  // The same rules the server applies, so Save is closed on a handle it would
  // only bounce back.
  const canSave =
    dirty &&
    Boolean(name.trim()) &&
    !validateUsername(normalizeUsername(handle));

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($name: String!, $username: String) { updateProfile(name: $name, username: $username) }`,
        { name, username: handle },
      );
      if (res.ok) {
        toast.success("Profile updated");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Profile
          <InfoTip
            content="Your name, and the picture people see next to it."
            docs="team.security"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-4">
        <AvatarPicker
          label="Change your picture"
          hasImage={Boolean(user.avatarUrl?.startsWith("data:"))}
          sources={{
            avatarUrl: user.avatarUrl,
            defaultSeed: user.id,
            gravatar,
          }}
          onSave={(image) =>
            gqlAction(
              `mutation($image: String) { updateMyAvatar(image: $image) }`,
              { image },
            )
          }
          preview={
            <UserAvatar
              name={user.name}
              username={user.username}
              avatarUrl={user.avatarUrl}
              size="3xl"
            />
          }
        >
          <div className="min-w-0">
            <p className="truncate text-base font-medium">{user.name}</p>
            <p className="mt-1 truncate text-sm text-muted-foreground">
              @{user.username}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {user.isInstanceAdmin && (
                <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                  <ShieldCheck className="size-3" />
                  Instance admin
                </Badge>
              )}
              <Badge
                variant={user.twoFactorEnabled ? "success" : "warning"}
                className="gap-1 px-1.5 py-0"
              >
                <KeyRound className="size-3" />
                {user.twoFactorEnabled ? "2FA on" : "2FA off"}
              </Badge>
            </div>
          </div>
        </AvatarPicker>
        <form className="mt-auto space-y-4" onSubmit={save}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="acct-name">Display name</Label>
              <Input
                id="acct-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <FieldLabel
                htmlFor="acct-handle"
                info="Your public handle across the instance. Lowercase letters, numbers, - and _."
                docs="team.security"
              >
                Handle
              </FieldLabel>
              <div className="relative">
                <span className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 font-mono text-sm text-muted-foreground">
                  @
                </span>
                <Input
                  id="acct-handle"
                  value={handle}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  className="pl-7 font-mono text-sm"
                  onChange={(e) =>
                    setHandle(
                      e.target.value.toLowerCase().replace(/[^a-z0-9_-]/g, "-"),
                    )
                  }
                />
              </div>
            </div>
          </div>
          <div className="flex justify-end">
            <Button type="submit" size="sm" disabled={pending || !canSave}>
              <PendingLabel pending={pending}>Save</PendingLabel>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function EmailCard({ user }: { user: PublicUser }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [email, setEmail] = React.useState(user.email);
  const [password, setPassword] = React.useState("");
  const dirty = email.trim().toLowerCase() !== user.email;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($email: String!, $currentPassword: String!) { updateEmail(email: $email, currentPassword: $currentPassword) }`,
        { email, currentPassword: password },
      );
      if (res.ok) {
        toast.success("Email updated");
        setPassword("");
        router.refresh();
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Email
          <InfoTip
            content="Where sign-in alerts and notifications go. Changing it needs your current password."
            docs="team.security"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col">
        <form className="flex flex-1 flex-col gap-4" onSubmit={save}>
          <div className="space-y-2">
            <Label htmlFor="acct-email">Email</Label>
            <Input
              id="acct-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="acct-email-pw">Current password</Label>
            <Input
              id="acct-email-pw"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="mt-auto flex justify-end">
            <Button
              type="submit"
              size="sm"
              disabled={pending || !dirty || !password}
            >
              <PendingLabel pending={pending}>Update email</PendingLabel>
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/**
 * Shortcuts into Settings → Security, each carrying the one fact that says
 * whether it needs attention.
 */
function SecurityCard({
  twoFactorEnabled,
  passkeys,
  sessions,
}: {
  twoFactorEnabled: boolean;
  passkeys: number;
  sessions: number;
}) {
  const shortcuts = [
    { icon: KeyRound, label: "Password", status: "Change it here" },
    {
      icon: ShieldCheck,
      label: "Two-factor",
      status: twoFactorEnabled ? "On" : "Off",
    },
    {
      icon: Fingerprint,
      label: "Passkeys",
      status: passkeys === 0 ? "None yet" : `${passkeys} registered`,
    },
    {
      icon: MonitorSmartphone,
      label: "Sessions",
      status: `${sessions} active`,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Security
          <InfoTip
            content="How this account proves it is you, and where it is signed in."
            docs="team.security"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col items-center gap-6 sm:flex-row">
        <AccountGraphic className="shrink-0" />
        <div className="grid w-full flex-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {shortcuts.map((s) => (
            <Link
              key={s.label}
              href="/settings/security"
              className="group flex items-center gap-3 rounded-lg border border-border p-3 transition-colors hover:border-foreground/20 hover:bg-accent"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-full border border-border bg-secondary">
                <s.icon className="size-4 text-muted-foreground" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{s.label}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {s.status}
                </p>
              </div>
              <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
            </Link>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
