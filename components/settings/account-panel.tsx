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
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import type { PublicUser } from "@/lib/types";

export function AccountPanel({
  user,
  passkeys,
  sessions,
}: {
  user: PublicUser;
  passkeys: number;
  sessions: number;
}) {
  return (
    <div className="space-y-4">
      {/* Direct grid children, so Profile and Email share one row's height
          instead of each ending wherever its own content stops. */}
      <div className="grid gap-4 lg:grid-cols-2">
        <ProfileCard user={user} />
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

function ProfileCard({ user }: { user: PublicUser }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(user.name);
  const dirty = name.trim() !== user.name;

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation ($name: String!) { updateProfile(name: $name) }`,
        { name },
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
              avatarColor={user.avatarColor}
              avatarUrl={user.avatarUrl}
              size="3xl"
            />
          }
        >
          <div className="min-w-0">
            <p className="truncate text-base font-medium">@{user.username}</p>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
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
        <form className="mt-auto flex items-end gap-2" onSubmit={save}>
          <div className="flex-1 space-y-2">
            <Label htmlFor="acct-name">Name</Label>
            <Input
              id="acct-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" disabled={pending || !dirty || !name.trim()}>
            {pending && <Loader2 className="size-4 animate-spin" />}
            Save
          </Button>
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
              {pending && <Loader2 className="size-4 animate-spin" />}
              Update email
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
