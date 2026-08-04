"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Crown, Repeat, ShieldCheck } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { InfoTip } from "@/components/ui/info-tip";
import { SimpleTooltip } from "@/components/ui/tooltip";
import { gqlAction } from "@/lib/graphql-client";
import type { TeamRoleDTO } from "@/lib/data/roles";

/**
 * Only what the card shows — the page passes the members already filtered.
 *
 * A TYPE, deliberately: this module is `"use client"`, so a runtime export the
 * server page called would resolve to a client reference and throw during the
 * RSC render. Types are erased, so the page builds these objects itself.
 */
export interface RoleHolder {
  userId: string;
  username: string;
  name: string;
  avatarColor: string;
  isPrimaryOwner: boolean;
  isInstanceAdmin: boolean;
}

/**
 * Who holds this role right now, under the summary — and a one-menu way to move
 * any of them off it.
 *
 * The editor above answers "what does this role grant"; the obvious next
 * question is "so who has it", and until now the only way to act on the answer
 * was to leave for the Members page and find the person again. Moving someone
 * applies IMMEDIATELY, unlike the permission form it sits beside: it is a
 * per-person action, not part of the role being edited, and staging it behind
 * the same Save would make one button mean two unrelated things.
 *
 * Gated on `manage_members`, NOT `manage_roles` — editing what a role grants and
 * choosing who holds it are different permissions, and someone may hold either
 * one alone.
 */
export function RoleMembersCard({
  role,
  members,
  roles,
  canManageMembers,
}: {
  role: TeamRoleDTO;
  /** The members holding `role`, already filtered by the page. */
  members: RoleHolder[];
  /** Every role of the team — the menu offers the others as destinations. */
  roles: TeamRoleDTO[];
  canManageMembers: boolean;
}) {
  const router = useRouter();
  const [moving, setMoving] = React.useState<string | null>(null);
  const targets = roles.filter((r) => r.id !== role.id);

  function move(holder: RoleHolder, target: TeamRoleDTO) {
    setMoving(holder.userId);
    void (async () => {
      const res = await gqlAction(
        `mutation($input: UpdateMemberInput!) { updateMember(input: $input) { userId } }`,
        { input: { userId: holder.userId, roleId: target.id } },
      );
      setMoving(null);
      if (res.ok) {
        toast.success(`${holder.username} is now ${target.name}`);
        router.refresh();
      } else {
        toast.error(res.error);
      }
    })();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex w-fit items-center gap-2 text-base">
          Members
          <InfoTip content="Who holds this role right now. Moving someone changes what they can do straight away — it doesn't wait for Save." />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {members.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nobody holds this role yet.
          </p>
        ) : (
          members.map((m) => {
            // The founder's rank is immutable — the server refuses, so don't
            // offer a menu that can only fail.
            const canMove =
              canManageMembers && !m.isPrimaryOwner && targets.length > 0;
            return (
              <div key={m.userId} className="flex items-center gap-2.5">
                <Avatar className="size-7 shrink-0">
                  <AvatarFallback
                    className="text-[10px]"
                    style={{ backgroundColor: m.avatarColor, color: "#000" }}
                  >
                    {m.username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1">
                    <span className="truncate text-sm font-medium">{m.name}</span>
                    {m.isPrimaryOwner && (
                      <SimpleTooltip content="Owns the team — their role can't be changed">
                        <span className="leading-none">
                          <Crown
                            className="size-3 shrink-0 text-amber-500"
                            aria-label="Team owner"
                          />
                        </span>
                      </SimpleTooltip>
                    )}
                    {m.isInstanceAdmin && (
                      <SimpleTooltip content="Instance admin">
                        <span className="leading-none">
                          <ShieldCheck
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-label="Instance admin"
                          />
                        </span>
                      </SimpleTooltip>
                    )}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    @{m.username}
                  </span>
                </span>
                {canMove && (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={moving !== null}
                        aria-label={`Move ${m.username} to another role`}
                      >
                        <Repeat className="size-3.5" />
                        Move
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuLabel>Move to</DropdownMenuLabel>
                      {targets.map((r) => (
                        <DropdownMenuItem
                          key={r.id}
                          className="cursor-pointer"
                          onSelect={() => move(m, r)}
                        >
                          <span className="min-w-0 flex-1 truncate">{r.name}</span>
                          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                            {r.capabilities.filter((c) => c !== "view").length}
                          </span>
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                )}
              </div>
            );
          })
        )}

        <Link
          href="/settings/members"
          className="group flex items-center gap-1.5 pt-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
        >
          {canManageMembers ? "Add or remove members" : "See every member"}
          <ArrowRight className="size-3 transition-transform group-hover:translate-x-0.5" />
        </Link>
      </CardContent>
    </Card>
  );
}
