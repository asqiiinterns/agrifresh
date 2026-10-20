import type { Product } from "../types/product";
import { products as demoProducts } from "./products";
import { supabase } from "../lib/supabase";
import type { DeliveryPointSummary } from "./account";

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  unit_label: string | null;
  price: number | string;
  vat_rate?: number | string | null;
  active: boolean;
  created_at: string;
  stock_quantity: number | string | null;
  origin_producer: string | null;
  origin_region: string | null;
  origin_label: string | null;
  origin_note: string | null;
  categories: { name: string; sort_order?: number | null } | { name: string; sort_order?: number | null }[] | null;
};

// Products added recently are highlighted to clients as new arrivals.
const NEW_PRODUCT_DAYS = 30;

const OTHER_CATEGORY = "Autres";

function toProduct(row: CatalogRow): Product {
  const relation = Array.isArray(row.categories) ? row.categories[0] : row.categories;
  const category = relation?.name?.trim() || OTHER_CATEGORY;
  const price = Number(row.price);
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? "",
    category,
    categorySort: relation?.sort_order ?? 9999,
    price: Number.isFinite(price) ? price : 0,
    vatRate: row.vat_rate === null || row.vat_rate === undefined ? undefined : Number(row.vat_rate),
    unit: row.unit_label ?? "unité",
    // No photo: a neutral placeholder (never another supplier's pictures).
    image: row.image_url ?? "",
    available: row.active,
    stock: row.stock_quantity === null ? undefined : Number(row.stock_quantity),
    origin: row.origin_producer || row.origin_region || row.origin_label || row.origin_note
      ? { producer: row.origin_producer ?? undefined, region: row.origin_region ?? undefined, label: row.origin_label ?? undefined, note: row.origin_note ?? undefined }
      : null,
    isNew: Date.now() - new Date(row.created_at).getTime() < NEW_PRODUCT_DAYS * 86_400_000,
  };
}

export async function fetchCatalog(): Promise<Product[]> {
  if (!supabase) return demoProducts;

  const { data, error } = await supabase
    .from("products")
    .select("id, name, description, image_url, unit_label, price, vat_rate, active, created_at, stock_quantity, origin_producer, origin_region, origin_label, origin_note, categories(name, sort_order)")
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;
  return ((data ?? []) as unknown as CatalogRow[]).map(toProduct);
}

// A buyer's catalogue across all the suppliers it may order from (20261115_multi_supplier_cart.sql).
export type BuyerSupplier = {
  client_id: string; org_id: string; name: string; business_name: string; current: boolean;
  show_prices: boolean; show_stock: boolean; show_origin: boolean;
  delivery_points: DeliveryPointSummary[];
};
export type BuyerCatalog = { buyerOrgId: string | null; suppliers: BuyerSupplier[]; products: Product[] };
type BuyerRow = Omit<CatalogRow, "categories" | "active"> & { client_id: string; category: string | null; category_sort?: number | null };

// Null before 20261115: the screen then keeps the single-supplier catalogue.
export async function fetchBuyerCatalog(): Promise<BuyerCatalog | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc("buyer_catalog");
  if (error) return null;
  const raw = data as { buyer_org_id: string | null; suppliers: BuyerSupplier[]; products: BuyerRow[] };
  return {
    buyerOrgId: raw.buyer_org_id,
    suppliers: raw.suppliers ?? [],
    products: (raw.products ?? []).map((row) => ({
      ...toProduct({ ...row, price: row.price ?? 0, active: true, categories: row.category ? { name: row.category, sort_order: row.category_sort } : null }),
      supplierId: row.client_id,
    })),
  };
}
