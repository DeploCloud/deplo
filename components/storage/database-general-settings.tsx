"use client";

// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import * as React from "react";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { Save, Image as ImageIcon } from "lucide-react";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FieldLabel } from "@/components/ui/info-tip";
import { DatabaseLogo } from "@/components/storage/database-logo";
import { DB_NAMES } from "@/components/storage/db-engines";
import {
  LOGO_ACCEPT_ATTR,
  LOGO_IMAGE_TYPES,
  MAX_LOGO_BYTES,
  MAX_LOGO_STRING_LEN,
} from "@/lib/apps/logo-shared";
import {
  ImageCropDialog,
  isCroppableLogo,
} from "@/components/shared/image-crop-dialog";
import { UnsavedChangesGuard } from "@/components/apps/unsaved-changes-guard";
import { DirtyHint } from "@/components/apps/settings/settings-shared";
import { formatBytes } from "@/lib/utils";
import { gqlAction } from "@/lib/graphql-client";
import type { DatabaseDTO } from "@/lib/data/databases";

/**
 * General settings for a database: its name and logo - its identity, so they share
 * one card, exactly like an App's General. The copy says so, because "will this
 * drop my database?"
 */
export function DatabaseGeneralSettings({ db }: { db: DatabaseDTO }) {
  const router = useRouter();
  const [name, setName] = React.useState(db.name);
  // Null ⇒ no uploaded logo, so the UI shows the ENGINE's real brand mark.
  const [logo, setLogo] = React.useState<string | null>(db.logo);
  const [picked, setPicked] = React.useState<File | null>(null);
  const logoInputRef = React.useRef<HTMLInputElement>(null);
  const [pending, startTransition] = React.useTransition();

  const [savedName, setSavedName] = React.useState(db.name);
  const nameDirty = name.trim() !== savedName;

  function saveName() {
    // Saved on the click - the field already shows the new name.
    const previous = savedName;
    const next = name.trim();
    setSavedName(next);
    setName(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $name: String!) { renameDatabase(id: $id, name: $name) { id name } }`,
        { id: db.id, name: next },
      );
      if (res.ok) toast.success("Database renamed");
      else {
        setSavedName(previous);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  function saveLogo(next: string | null) {
    const previous = logo;
    setLogo(next);
    startTransition(async () => {
      const res = await gqlAction(
        `mutation($id: String!, $logo: String) { updateDatabaseLogo(id: $id, logo: $logo) { id } }`,
        { id: db.id, logo: next },
      );
      if (res.ok) toast.success(next ? "Logo updated" : "Logo cleared");
      else {
        setLogo(previous);
        toast.error(res.error);
      }
      router.refresh();
    });
  }

  // Validate a picked image (type + size) and either open the crop dialog or,
  // for the formats a canvas cannot handle, store the file exactly as uploaded.
  async function pickLogo(file: File) {
    if (
      !LOGO_IMAGE_TYPES.includes(file.type as (typeof LOGO_IMAGE_TYPES)[number])
    ) {
      toast.error("Unsupported image - use PNG, JPEG, WebP, GIF or SVG");
      return;
    }
    if (file.size > MAX_LOGO_BYTES) {
      toast.error(`Image too large (max ${formatBytes(MAX_LOGO_BYTES)})`);
      return;
    }
    if (await isCroppableLogo(file)) {
      setPicked(file);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUri = typeof reader.result === "string" ? reader.result : "";
      if (!dataUri) {
        toast.error("Could not read image");
        return;
      }
      saveLogo(dataUri);
    };
    reader.onerror = () => toast.error("Could not read image");
    reader.readAsDataURL(file);
  }

  const engine = DB_NAMES[db.type] ?? db.type;

  return (
    <>
      <Card>
        <CardContent className="space-y-6 pt-6">
          {/* Logo */}
          <div className="space-y-3">
            <FieldLabel
              info={`Shown for this database on the dashboard. Defaults to the ${engine} logo - upload an image to use your own`}
            >
              Logo
            </FieldLabel>
            <div className="flex flex-wrap items-center gap-4">
              <DatabaseLogo type={db.type} logo={logo} size={48} />
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => logoInputRef.current?.click()}
                  disabled={pending}
                >
                  <ImageIcon className="size-4" />
                  {logo ? "Replace image" : "Upload image"}
                </Button>
                {logo && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground"
                    onClick={() => saveLogo(null)}
                    disabled={pending}
                  >
                    Remove
                  </Button>
                )}
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              PNG, JPEG, WebP, GIF, SVG or ICO · up to{" "}
              {formatBytes(MAX_LOGO_BYTES)}. Remove it to go back to the{" "}
              {engine} logo.
            </p>
            <ImageCropDialog
              file={picked}
              variant="logo"
              onClose={() => setPicked(null)}
              onCropped={(dataUri) => {
                setPicked(null);
                if (dataUri.length > MAX_LOGO_STRING_LEN) {
                  toast.error("That image is too large");
                  return;
                }
                saveLogo(dataUri);
              }}
            />
            <input
              ref={logoInputRef}
              type="file"
              accept={LOGO_ACCEPT_ATTR}
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void pickLogo(file);
                e.target.value = "";
              }}
            />
          </div>

          {/* Name - saved with the button below; the logo saves on pick. */}
          <div className="max-w-md space-y-2 border-t border-border pt-6">
            <Label htmlFor="db-name">Database name</Label>
            <Input
              id="db-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              A label for the dashboard. The connection string keeps pointing at{" "}
              <code className="font-mono">{db.host}</code> - renaming never
              restarts the database or changes how apps reach it.
            </p>
          </div>
        </CardContent>
        <CardFooter className="justify-between border-t border-border pt-4">
          <DirtyHint dirty={nameDirty} />
          <Button
            size="sm"
            onClick={saveName}
            disabled={pending || !nameDirty || !name.trim()}
          >
            <Save className="size-4" />
            Save name
          </Button>
        </CardFooter>
      </Card>

      {/* Warn before leaving with an unsaved name (the logo saves on pick). */}
      <UnsavedChangesGuard when={nameDirty} />
    </>
  );
}
