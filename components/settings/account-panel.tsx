"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateProfileAction,
  updateEmailAction,
  changePasswordAction,
} from "@/lib/actions/account";
import type { PublicUser } from "@/lib/types";

export function AccountPanel({ user }: { user: PublicUser }) {
  return (
    <div className="space-y-4">
      <ProfileCard user={user} />
      <EmailCard user={user} />
      <PasswordCard />
    </div>
  );
}

function ProfileCard({ user }: { user: PublicUser }) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  const [name, setName] = React.useState(user.name);
  const dirty = name.trim() !== user.name;

  function save() {
    startTransition(async () => {
      const res = await updateProfileAction({ name });
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
        <CardTitle className="text-base">Profile</CardTitle>
        <CardDescription>Your name and avatar.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center gap-3">
          <Avatar className="size-12">
            <AvatarFallback
              style={{ backgroundColor: user.avatarColor, color: "#000" }}
            >
              {user.name.slice(0, 2).toUpperCase()}
            </AvatarFallback>
          </Avatar>
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
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !dirty || !name.trim()}
          >
            {pending ? "Saving…" : "Save"}
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
      const res = await updateEmailAction({ email, currentPassword: password });
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
        <CardTitle className="text-base">Email</CardTitle>
        <CardDescription>
          Changing your email requires your current password.
        </CardDescription>
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

function PasswordCard() {
  const [pending, startTransition] = React.useTransition();
  const [current, setCurrent] = React.useState("");
  const [next, setNext] = React.useState("");
  const [confirm, setConfirm] = React.useState("");

  function save() {
    if (next !== confirm) {
      toast.error("New passwords don't match");
      return;
    }
    startTransition(async () => {
      const res = await changePasswordAction({
        currentPassword: current,
        newPassword: next,
      });
      if (res.ok) {
        toast.success("Password changed");
        setCurrent("");
        setNext("");
        setConfirm("");
      } else {
        toast.error(res.error);
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Password</CardTitle>
        <CardDescription>Choose a strong, unique password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="acct-current">Current password</Label>
          <Input
            id="acct-current"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="acct-new">New password</Label>
            <Input
              id="acct-new"
              type="password"
              value={next}
              onChange={(e) => setNext(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="acct-confirm">Confirm new password</Label>
            <Input
              id="acct-confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </div>
        </div>
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={save}
            disabled={pending || !current || next.length < 8}
          >
            {pending ? "Saving…" : "Change password"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
