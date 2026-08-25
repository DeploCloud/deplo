"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { UserAvatar } from "@/components/shared/user-avatar";
import { AvatarPicker } from "@/components/shared/avatar-picker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InfoTip } from "@/components/ui/info-tip";
import { gqlAction } from "@/lib/graphql-client";
import type { PublicUser } from "@/lib/types";

export function AccountPanel({ user }: { user: PublicUser }) {
  return (
    <div className="space-y-4">
      <ProfileCard user={user} />
      <EmailCard user={user} />
    </div>
  );
}

function ProfileCard({ user }: { user: PublicUser }) {
  const router = useRouter();
  const [, startTransition] = React.useTransition();
  const [name, setName] = React.useState(user.name);
  const dirty = name.trim() !== user.name;

  function save() {
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
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Profile
          <InfoTip
            content="Your name, and the picture people see next to it."
            docs="team.security"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
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
                size="2xl"
              />
            }
          />
          <div className="flex-1 space-y-2">
            <Label htmlFor="acct-name">Name</Label>
            <Input
              id="acct-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button size="sm" onClick={save} disabled={!dirty || !name.trim()}>
            Save
          </Button>
        </div>
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

  function save() {
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
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Email
          <InfoTip
            content="Changing your email requires your current password."
            docs="team.security"
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="acct-email">Email</Label>
            <Input
              id="acct-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="acct-email-pw">Current password</Label>
            <Input
              id="acct-email-pw"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !dirty || !password}
          >
            {pending ? "Saving…" : "Update email"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
