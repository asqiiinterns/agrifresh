import { supabase } from "../lib/supabase";

// The shared list of categories, managed by Appro+ (20261116_catalog_numbers.sql).
import type { CategoryField } from "./productAdmin";
// attributes (20261202): the fields of the product sheet of this category.
export type PlatformCategory = { id: string; name: string; parent_id: string | null; sort_order: number; active: boolean; products: number; attributes?: CategoryField[] };

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchPlatformCategories(): Promise<PlatformCategory[]> {
  const { data, error } = await client().rpc("platform_categories");
  if (error) throw error;
  return (data ?? []) as PlatformCategory[];
}

export async function saveCategory(id: string | null, input: { name: string; parentId: string | null; sortOrder: number | null; active: boolean }): Promise<string> {
  const { data, error } = await client().rpc("platform_save_category", {
    p_id: id, p_name: input.name, p_parent_id: input.parentId, p_sort_order: input.sortOrder, p_active: input.active,
  });
  if (error) throw error;
  return data as string;
}

// The product sheet of a category: its fields (a list of choices, a number or a text), in order.
export async function saveCategoryFields(id: string, fields: Omit<CategoryField, "key">[] & { key?: string }[]): Promise<void> {
  const { error } = await client().rpc("platform_set_category_fields", { p_category_id: id, p_fields: fields });
  if (error) throw error;
}
