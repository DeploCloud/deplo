"use client";

import { Input } from "@/components/ui/input";
import { FieldLabel } from "@/components/ui/info-tip";
import { DestinationCombobox } from "@/components/storage/destination-combobox";
import { noun, type BackupTarget, type Destination } from "./target";

// ScheduleFields - the editable settings of a schedule, shared by the create and edit forms.
export type ScheduleFields = {
  name: string;
  destinationId: string;
  schedule: string;
  timezone: string;
  retention: number;
};

// NameField - the schedule's name, shared by the wizard's last step and the edit form.
export function NameField({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="backup-name"
        info="What this schedule is called in the list. Follows the frequency until you change it."
        docs="backups.schedule"
      >
        Name
      </FieldLabel>
      <Input
        id="backup-name"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
      />
    </div>
  );
}

// DestinationField - where the archives are written: the wizard's first step, and one row of the edit form.
export function DestinationField({
  value,
  onChange,
  target,
  destinations,
  canTestDestinations,
}: {
  value: string;
  onChange: (value: string) => void;
  target: BackupTarget;
  destinations: Destination[];
  canTestDestinations: boolean;
}) {
  return (
    <div className="space-y-2">
      <FieldLabel
        htmlFor="backup-destination"
        info="Where scheduled backups are written. Each one shows whether Deplo could reach it."
        docs="backups.destinations"
      >
        Destination
      </FieldLabel>
      <DestinationCombobox
        id="backup-destination"
        destinations={destinations}
        value={value}
        onChange={onChange}
        sameDiskServerId={target.serverId}
        sameDiskNoun={noun(target)}
        canProbe={canTestDestinations}
      />
    </div>
  );
}
