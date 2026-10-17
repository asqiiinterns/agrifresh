import type { Product } from "../types/product";
import { products as demoProducts } from "./products";
import { supabase } from "../lib/supabase";

type CatalogRow = {
  id: string;
  name: string;
  description: string | null;
  image_url: string | null;
  unit_label: string | null;
  price: number | string;
  active: boolean;
  created_at: string;
  categories: { name: string } | { name: string }[] | null;
};

// Products added recently are highlighted to clients as new arrivals.
const NEW_PRODUCT_DAYS = 30;

const productCategories: Product["category"][] = ["Jus frais", "Fruits", "Légumes", "Épicerie"];

function categoryFor(name: string | undefined): Product["category"] {
  return productCategories.find((item) => item.toLocaleLowerCase("fr") === name?.trim().toLocaleLowerCase("fr")) ?? "Épicerie";
}

export async function fetchCatalog(): Promise<Product[]> {
  if (!supabase) return demoProducts;

  const { data, error } = await supabase
    .from("products")
    .select("id, name, description, image_url, unit_label, price, active, created_at, categories(name)")
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as unknown as CatalogRow[]).map((row) => {
    const relation = Array.isArray(row.categories) ? row.categories[0] : row.categories;
    const category = categoryFor(relation?.name);
    const price = Number(row.price);
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      category,
      price: Number.isFinite(price) ? price : 0,
      unit: row.unit_label ?? "unité",
      image: row.image_url || demoProducts.find((item) => item.category === category)?.image || demoProducts[0].image,
      available: row.active,
      isNew: Date.now() - new Date(row.created_at).getTime() < NEW_PRODUCT_DAYS * 86_400_000,
    };
  });
}
