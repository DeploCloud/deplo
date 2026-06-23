import { writeFileSync } from "node:fs";
import { printSchema, lexicographicSortSchema } from "graphql";
import { schema } from "@/lib/graphql/schema";

const sdl = printSchema(lexicographicSortSchema(schema));
writeFileSync("schema.graphql", sdl + "\n");
console.log("wrote schema.graphql");
