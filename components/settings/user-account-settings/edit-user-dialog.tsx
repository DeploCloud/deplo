"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  UserAccountSettings,
  type EditUserSeedFlags,
  type EditUserSeedUser,
} from "./account-editor";

export function EditUserDialog({
  user,
  seed,
  isSelf,
  open,
  onOpenChange,
}: {
  user: EditUserSeedUser;
  seed?: EditUserSeedFlags;
  isSelf: boolean;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader className="sr-only">
          <DialogTitle>@{user.username}</DialogTitle>
          <DialogDescription>
            Instance-wide account and permissions.
          </DialogDescription>
        </DialogHeader>
        <UserAccountSettings
          user={user}
          seed={seed}
          isSelf={isSelf}
          onCancel={() => onOpenChange(false)}
          onSaved={() => onOpenChange(false)}
          onDeleted={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
