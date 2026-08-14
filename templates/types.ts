import type z from "zod";
import type { templateListQuerySchema } from "./schema";

export type TemplateListQuery = z.input<typeof templateListQuerySchema>;
