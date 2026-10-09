import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton, TextLine } from "@/components/ui/skeleton";
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

// Type and Modified by carry an info tip, Updated does not.
const FACETS = [true, true, false];

const CARDS = [
  { name: "w-20", sub: "w-41", rows: 9 },
  { name: "w-12", sub: "w-24", rows: 5 },
  { name: "w-16", sub: "w-32", rows: 3 },
];

const KEY_WIDTHS = ["w-36", "w-27", "w-38.5", "w-26", "w-23", "w-28", "w-20"];

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
        <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
          {/* The invisible input gives the box its real flex basis. */}
          <div className="relative min-w-[11rem] flex-1 basis-full sm:basis-auto lg:max-w-[16rem]">
            <Input
              tabIndex={-1}
              aria-hidden
              readOnly
              className="invisible h-9"
            />
            <Skeleton className="absolute inset-0" />
          </div>
          {FACETS.map((info, i) => (
            <div
              key={i}
              className="flex min-w-[10rem] flex-1 items-center gap-1 lg:min-w-0"
            >
              <Skeleton className="h-9 min-w-0 flex-1" />
              {info && <Skeleton className="size-3.5 shrink-0 rounded-full" />}
            </div>
          ))}
          <Button variant="ghost" disabled className="invisible shrink-0">
            Clear filters
          </Button>
          <Skeleton className="h-9 w-[11.5rem] shrink-0" />
        </div>

        <section className="space-y-3">
          <div className="flex w-full items-center gap-2 rounded-lg border border-border px-4">
            <div className="flex min-w-0 flex-1 items-center gap-3 py-3">
              <Skeleton className="size-4 shrink-0 rounded" />
              <Skeleton className="size-8 shrink-0 rounded-md" />
              <div className="min-w-0 flex-1">
                <TextLine type="text-sm" className="w-20" />
                <TextLine type="mt-1 text-xs" className="w-28" />
              </div>
            </div>
          </div>

          <div className="space-y-4 sm:pl-4">
            {CARDS.map((card, c) => (
              <Card key={c}>
                <CardHeader className="flex-row items-center justify-between gap-3 space-y-0">
                  <div className="flex min-w-0 flex-1 items-center gap-3">
                    <Skeleton className="size-4 shrink-0 rounded" />
                    <Skeleton className="size-8 shrink-0 rounded-md" />
                    <div className="min-w-0">
                      <TextLine
                        type="text-base leading-none lg:text-lg"
                        className={card.name}
                      />
                      <TextLine type="mt-1 text-xs" className={card.sub} />
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-8 w-[4.5rem]" />
                    <Skeleton className="h-8 w-[5.25rem]" />
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
                        {Array.from({ length: card.rows }).map((_, row) => (
                          <TableRow key={row}>
                            <TableCell>
                              <TextLine
                                type="text-xs"
                                className={
                                  KEY_WIDTHS[(row + c) % KEY_WIDTHS.length]
                                }
                              />
                            </TableCell>
                            <TableCell>
                              <Skeleton className="h-7 w-full" />
                            </TableCell>
                            <TableCell>
                              <TextLine type="text-xs" className="w-16" />
                            </TableCell>
                            <TableCell>
                              <div className="flex items-center gap-2">
                                <Skeleton className="size-5 shrink-0 rounded-full" />
                                <TextLine type="text-xs" className="w-9" />
                              </div>
                            </TableCell>
                            <TableCell>
                              <div className="flex justify-end gap-1">
                                <Skeleton className="size-8" />
                                <Skeleton className="size-8" />
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
      </TabsContent>
    </Tabs>
  );
}
