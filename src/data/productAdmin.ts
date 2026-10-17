import { supabase } from "../lib/supabase";

export type AdminProduct = {
  id: string;
  category_id: string | null;
  name: string;
  description: string;
  image_url: string | null;
  unit_label: string;
  price: number | string;
  vat_rate: number | string;
  stock_quantity: number | string;
  active: boolean;
  origin_producer: string | null;
  origin_region: string | null;
  origin_label: string | null;
  origin_note: string | null;
  created_at: string;
};

export type Category = { id: string; name: string };

export type ProductInput = {
  category_id: string | null;
  name: string;
  description: string;
  image_url: string;
  unit_label: string;
  price: number;
  vat_rate: number;
  stock_quantity: number;
  active: boolean;
  origin_producer: string;
  origin_region: string;
  origin_label: string;
  origin_note: string;
};

export const VAT_RATES = [0, 7, 13, 19];

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

// RLS: staff see inactive products too.
export async function fetchAdminProducts(): Promise<AdminProduct[]> {
  const { data, error } = await client()
    .from("products")
    .select("id, category_id, name, description, image_url, unit_label, price, vat_rate, stock_quantity, active, origin_producer, origin_region, origin_label, origin_note, created_at")
    .order("name");
  if (error) throw error;
  return (data ?? []) as AdminProduct[];
}

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await client().from("categories").select("id, name").order("sort_order");
  if (error) throw error;
  return (data ?? []) as Category[];
}

const slugify = (name: string) => name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function saveProduct(id: string | null, input: ProductInput): Promise<void> {
  const values = {
    category_id: input.category_id,
    name: input.name.trim(),
    description: input.description.trim(),
    image_url: input.image_url.trim() || null,
    unit_label: input.unit_label.trim() || "unité",
    price: input.price,
    vat_rate: input.vat_rate,
    stock_quantity: input.stock_quantity,
    active: input.active,
    origin_producer: input.origin_producer.trim() || null,
    origin_region: input.origin_region.trim() || null,
    origin_label: input.origin_label.trim() || null,
    origin_note: input.origin_note.trim() || null,
    updated_at: new Date().toISOString(),
  };
  const query = id
    ? client().from("products").update(values).eq("id", id)
    : client().from("products").insert({ ...values, slug: `${slugify(input.name) || "produit"}-${Date.now().toString(36)}` });
  const { error } = await query;
  if (error) throw error;
}
