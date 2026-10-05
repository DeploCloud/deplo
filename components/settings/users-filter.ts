import type { GlobalUserDTO } from "@/lib/data/members/instance-users";
import { inAny } from "@/components/shared/facet-filtering";

export const ACCESS_OPTIONS = [
  { value: "admin", label: "Instance admins" },
  { value: "member", label: "Members" },
];

export const USER_STATUS_OPTIONS = [
  { value: "active", label: "Active" },
  { value: "suspended", label: "Suspended" },
];

export const accessOf = (u: GlobalUserDTO) =>
  u.isInstanceAdmin ? "admin" : "member";
export const statusOf = (u: GlobalUserDTO) =>
  u.suspended ? "suspended" : "active";

export function filterUsers(
  users: GlobalUserDTO[],
  {
    query,
    teams,
    access,
    statuses,
  }: { query: string; teams: string[]; access: string[]; statuses: string[] },
): GlobalUserDTO[] {
  const q = query.trim().toLowerCase();
  return users.filter(
    (u) =>
      inAny(
        teams,
        u.teams.map((t) => t.slug),
      ) &&
      inAny(access, [accessOf(u)]) &&
      inAny(statuses, [statusOf(u)]) &&
      (!q ||
        u.username.toLowerCase().includes(q) ||
        u.name.toLowerCase().includes(q)),
  );
}
