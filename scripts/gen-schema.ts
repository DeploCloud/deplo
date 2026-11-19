import { writeFileSync } from "node:fs";
import { printSchema, lexicographicSortSchema } from "graphql";
import { schema } from "@/lib/graphql/schema";

const sdl = printSchema(lexicographicSortSchema(schema));
writeFileSync("lib/graphql/schema.graphql", sdl + "\n");
console.log("wrote lib/graphql/schema.graphql");
