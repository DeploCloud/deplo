// SPDX-FileCopyrightText: 2026 DeploCloud
// SPDX-License-Identifier: AGPL-3.0-only

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tabs,
  TabsContent,
  UnderlineTabsList,
  UnderlineTabsTrigger,
} from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

// The toolbar's six facets: Project, Environment, Source, Type, Modified by,
// Updated. They share the row's width evenly, as the real ones do.
const FACETS = 6;

// One project section per entry, each holding this many app cards, each card this
// many variable rows. Both sections render open, like the page's own first paint.
const SECTIONS = [[4, 3], [2]];

const KEY_WIDTHS = ["w-32", "w-44", "w-28", "w-36"];

export default function Loading() {
  return (
    <Tabs
      defaultValue="app"
      role="status"
      aria-busy
      aria-label="Loading variables"
    >
      <UnderlineTabsList>
        <UnderlineTabsTrigger value="app">All</UnderlineTabsTrigger>
        <UnderlineTabsTrigger value="shared">Shared</UnderlineTabsTrigger>
      </UnderlineTabsList>

      <TabsContent value="app" className="space-y-4">
        {/* EnvFilters: search, the facets and their info icons, the reserved
            Clear slot, the sort picker, then the Collapse all action. */}
        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
          <div className="min-w-[11rem] flex-1 basis-full sm:basis-auto lg:max-w-[16rem]">
            <Skeleton className="h-9 w-full" />
          </div>
          {Array.from({ length: FACETS }).map((_, i) => (
            <div
              key={i}
              className="flex min-w-[10rem] flex-1 items-center gap-1 lg:min-w-0"
            >
              <Skeleton className="h-9 min-w-0 flex-1" />
              <Skeleton className="size-3.5 shrink-0 rounded-full" />
            </div>
          ))}
          {/* Invisible in the real toolbar too, until a filter is on - but it holds
              its width either way, so the placeholder has to hold it as well. */}
          <Button variant="ghost" disabled className="invisible shrink-0">
            Clear filters
          </Button>
          <Skeleton className="h-9 w-[11.5rem] shrink-0" />
          <div className="flex shrink-0 items-center gap-2">
            <Skeleton className="h-9 w-[8.5rem]" />
          </div>
        </div>

        {SECTIONS.map((cards, section) => (
          <section key={section} className="space-y-3">
            {/* Project header: chevron, colour tile, name over counts. */}
            <div className="flex w-full items-center gap-2 rounded-lg border border-border px-4">
              <div className="flex min-w-0 flex-1 items-center gap-3 py-3">
                <Skeleton className="size-4 shrink-0 rounded" />
                <Skeleton className="size-8 shrink-0 rounded-md" />
                <div className="min-w-0 flex-1">
                  <Skeleton className="h-3.5 w-36" />
                  <Skeleton className="mt-1 h-3 w-28" />
                </div>
              </div>
            </div>

            <div className="space-y-4 sm:pl-4">
              {cards.map((rows, card) => (
                <Card key={card}>
                  <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <Skeleton className="size-4 shrink-0 rounded" />
                      <Skeleton className="size-8 shrink-0 rounded-md" />
                      <div className="min-w-0">
                        <Skeleton className="h-[18px] w-44" />
                        <Skeleton className="mt-1 h-3 w-32" />
                      </div>
                    </div>
                    {/* Add / Open */}
                    <div className="flex items-center gap-2">
                      <Skeleton className="h-8 w-[4.5rem] rounded-md" />
                      <Skeleton className="h-8 w-[5.25rem] rounded-md" />
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="overflow-hidden rounded-lg border border-border">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead className="whitespace-nowrap">
                              Key
                            </TableHead>
                            <TableHead className="w-full">Value</TableHead>
                            <TableHead className="whitespace-nowrap">
                              Last modified
                            </TableHead>
                            <TableHead className="whitespace-nowrap">
                              Modified by
                            </TableHead>
                            <TableHead className="text-right whitespace-nowrap">
                              Actions
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {Array.from({ length: rows }).map((_, row) => (
                            <TableRow key={row}>
                              <TableCell>
                                <Skeleton
                                  className={cn(
                                    "h-3.5",
                                    KEY_WIDTHS[row % KEY_WIDTHS.length],
                                  )}
                                />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-4 w-56" />
                              </TableCell>
                              <TableCell>
                                <Skeleton className="h-3 w-16" />
                              </TableCell>
                              <TableCell>
                                <div className="flex items-center gap-2">
                                  <Skeleton className="size-5 shrink-0 rounded-full" />
                                  <Skeleton className="h-3 w-20" />
                                </div>
                              </TableCell>
                              <TableCell>
                                <div className="flex justify-end gap-1">
                                  <Skeleton className="size-8 rounded-md" />
                                  <Skeleton className="size-8 rounded-md" />
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </div>
          </section>
        ))}
      </TabsContent>
    </Tabs>
  );
}
