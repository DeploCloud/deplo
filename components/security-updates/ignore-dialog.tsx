"use client";

import * as React from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { gqlAction } from "@/lib/graphql-client";
import type { Subject } from "./types";

export function IgnoreDialog({
  open,
  onOpenChange,
  subject,
  packageName,
  vulnIds,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  subject: Subject;
  packageName: string;
  vulnIds: string[];
  onDone: () => void;
}) {
  const [reason, setReason] = React.useState("");
  const [days, setDays] = React.useState("90");
  const [pending, startTransition] = React.useTransition();

  function submit(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($appId: ID, $databaseId: ID, $vulnIds: [String!]!, $reason: String, $days: Int) {
           ignoreSecurityUpdate(appId: $appId, databaseId: $databaseId, vulnIds: $vulnIds, reason: $reason, days: $days)
         }`,
        {
          appId: subject.appId ?? null,
          databaseId: subject.databaseId ?? null,
          vulnIds,
          reason,
          days: Number(days),
        },
      );
      if (!res.ok) return void toast.error(res.error);
      toast.success(`${packageName} is ignored for ${days} days`);
      onOpenChange(false);
      onDone();
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form className="grid gap-4" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Ignore this update?</DialogTitle>
            <DialogDescription>
              <strong>{packageName}</strong> stops counting and alerting until
              then. A new flaw in it still shows.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="ignore-reason">Reason</Label>
            <Textarea
              id="ignore-reason"
              value={reason}
              maxLength={500}
              placeholder="Not reachable from outside, fixed in the next release"
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="ignore-days">Ignore for</Label>
            <Select value={days} onValueChange={setDays}>
              <SelectTrigger id="ignore-days">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
                <SelectItem value="180">180 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Ignore
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
