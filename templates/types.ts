import z from "zod";
import { categoryListQuerySchema, templateListQuerySchema } from "./schema";

export type TemplateListQuery = z.input<typeof templateListQuerySchema>;
export type CategoryListQuery = z.input<typeof categoryListQuerySchema>;
