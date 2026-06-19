"use client";

import * as React from "react";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { ALL_CAPABILITIES, type Capability, type Role } from "@/lib/types";
import { CAPABILITY_META, CAPABILITY_PRESETS } from "@/lib/membership-shared";

const ROLES: { value: Role; label: string }[] = [
  { value: "owner", label: "Owner" },
  { value: "member", label: "Member" },
  { value: "viewer", label: "Viewer" },
];

/**
 * Role + per-capability picker shared by the invite, create-user and edit-member
 * flows. Choosing a role applies its preset to the capability checkboxes; ticking
 * a capability individually keeps the role label but tailors the set. `view` is
 * always on (it's the floor for any member) and rendered disabled.
 */
export function CapabilityPicker({
  role,
  capabilities,
  onRoleChange,
  onCapabilitiesChange,
  idPrefix = "cap",
}: {
  role: Role;
  capabilities: Capability[];
  onRoleChange: (role: Role) => void;
  onCapabilitiesChange: (caps: Capability[]) => void;
  idPrefix?: string;
}) {
  function pickRole(next: Role) {
    onRoleChange(next);
    onCapabilitiesChange([...CAPABILITY_PRESETS[next]]);
  }

  function toggle(cap: Capability, on: boolean) {
    if (cap === "view") return; // always-on floor
    const set = new Set(capabilities);
    if (on) set.add(cap);
    else set.delete(cap);
    set.add("view");
    onCapabilitiesChange(ALL_CAPABILITIES.filter((c) => set.has(c)));
  }

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <Label>Role</Label>
        <Select value={role} onValueChange={(v) => pickRole(v as Role)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLES.map((r) => (
              <SelectItem key={r.value} value={r.value}>
                {r.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          A role is a preset. Fine-tune the exact permissions below.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Permissions</Label>
        <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
          {ALL_CAPABILITIES.map((cap) => {
            const checked = capabilities.includes(cap);
            const meta = CAPABILITY_META[cap];
            return (
              <label
                key={cap}
                htmlFor={`${idPrefix}-${cap}`}
                className="flex cursor-pointer items-start gap-2"
                title={meta.description}
              >
                <Checkbox
                  id={`${idPrefix}-${cap}`}
                  checked={checked}
                  disabled={cap === "view"}
                  onCheckedChange={(v) => toggle(cap, v === true)}
                  className="mt-0.5"
                />
                <span className="text-sm leading-tight">
                  {meta.label}
                  <span className="block text-xs text-muted-foreground">
                    {meta.description}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
    </div>
  );
}
