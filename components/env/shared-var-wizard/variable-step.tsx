"use client";

import { EnvRowsEditor, type EnvRow } from "@/components/env/env-rows-editor";
import { SecretRow } from "@/components/env/secret-row";
import { SECRET_EDIT_BLOCKED } from "@/components/env/env-edit-button";

export function VariableStep({
  rows,
  onRowsChange,
  editing,
  frozen,
  secret,
  onSecretChange,
}: {
  rows: EnvRow[];
  onRowsChange: (next: EnvRow[]) => void;
  editing: boolean;
  frozen: boolean;
  secret: boolean;
  onSecretChange: (v: boolean) => void;
}) {
  return (
    <>
      <EnvRowsEditor
        rows={rows}
        onChange={onRowsChange}
        keyPlaceholder="DATABASE_URL"
        singleRow={editing}
        keyDisabled={editing}
        valueReadOnly={frozen}
      />
      {frozen ? (
        <p className="text-xs text-muted-foreground">
          {SECRET_EDIT_BLOCKED} You can still change who it is shared with.
        </p>
      ) : (
        <SecretRow secret={secret} onChange={onSecretChange} />
      )}
    </>
  );
}
