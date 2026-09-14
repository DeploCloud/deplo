"use client";

import { Ban, Crown, ShieldCheck } from "lucide-react";
import { TeamAvatar, UserAvatar } from "@/components/shared/user-avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { timeAgo } from "@/lib/utils";
import type { UserDetailDTO } from "@/lib/data/members/instance-users";
import type { EditUserSeedUser } from "./account-editor";

// AccountHeader - the avatar, the name and the state badges for one account.
export function AccountHeader({
  user,
  isOwner,
  isAdmin,
  suspended,
  email,
}: {
  user: EditUserSeedUser;
  isOwner: boolean;
  isAdmin: boolean;
  suspended: boolean;
  email?: string;
}) {
  return (
    <div className="flex items-center gap-3">
      <UserAvatar
        name={user.name}
        username={user.username}
        avatarUrl={user.avatarUrl}
        size="xl"
        className="shrink-0"
      />
      <div className="min-w-0">
        <h2 className="flex flex-wrap items-center gap-2 text-base leading-none font-semibold tracking-tight lg:text-lg">
          @{user.username}
          {/* The badges read the SAVED state, never the form: the header says
              who this account is, the form says what it is about to become. */}
          {isOwner ? (
            <Badge variant="secondary" className="gap-1 px-1.5 py-0">
              <Crown className="size-3" />
              Owner
            </Badge>
          ) : (
            isAdmin && (
              <Badge variant="secondary" className="gap-1 px-1.5 py-0">
                <ShieldCheck className="size-3" />
                Admin
              </Badge>
            )
          )}
          {suspended && (
            <Badge variant="destructive" className="gap-1 px-1.5 py-0">
              <Ban className="size-3" />
              Suspended
            </Badge>
          )}
        </h2>
        <p className="mt-1 truncate text-sm text-muted-foreground">
          {user.name && user.name !== user.username ? `${user.name} · ` : ""}
          {email ?? "Instance-wide account & permissions."}
        </p>
      </div>
    </div>
  );
}

// AccountMeta - the read-only identity strip and the team chips under it.
export function AccountMeta({
  createdAt,
  teamCount,
  suspended,
  teams,
}: {
  createdAt: string | null;
  teamCount: number;
  suspended: boolean;
  teams: UserDetailDTO["teams"] | null;
}) {
  return (
    <>
      <div className="grid grid-cols-3 gap-2 rounded-lg border border-border p-3">
        <Meta label="Joined" value={createdAt ? timeAgo(createdAt) : "—"} />
        <Meta label="Teams" value={String(teamCount)} />
        <Meta label="Sign-in" value={suspended ? "Blocked" : "Allowed"} />
      </div>
      {/* The chips need the fetch but the seed already carries the COUNT, so the
          row that is coming is held open instead of pushing the sections down. */}
      {teams == null && teamCount > 0 && (
        <div className="flex flex-wrap gap-1.5">
          <Skeleton className="h-[22px] w-32 rounded-full" />
        </div>
      )}
      {teams && teams.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {teams.map((t) => (
            <span
              key={t.teamId}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
            >
              <TeamAvatar
                name={t.teamName}
                avatarUrl={t.teamAvatarUrl}
                size="xs"
              />
              <span className="font-medium">{t.teamName}</span>
              <span className="text-muted-foreground capitalize">{t.role}</span>
            </span>
          ))}
        </div>
      )}
    </>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value}</p>
    </div>
  );
}
