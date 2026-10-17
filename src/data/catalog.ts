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
  categories: { name: string } | { name: string }[] | null;
};

function categoryFor(name: string | null | undefined): Product["category"] {
  const normalized = name?.trim().toLocaleLowerCase("fr");
  const category = ["Jus frais", "Fruits", "Légumes", "Épicerie"].find(
    (item) => item.toLocaleLowerCase("fr") === normalized
  );
  return (category as Product["category"] | undefined) ?? "Épicerie";
}

function categoryName(row: CatalogRow): string | undefined {
  const category = Array.isArray(row.categories) ? row.categories[0] : row.categories;
  return category?.name;
}

function fallbackImage(category: Product["category"]): string {
  return demoProducts.find((product) => product.category === category)?.image ?? demoProducts[0].image;
}

export async function fetchCatalog(): Promise<Product[]> {
  if (!supabase) return demoProducts;

  const { data, error } = await supabase
    .from("products")
    .select("id, name, description, image_url, unit_label, price, active, categories(name)")
    .eq("active", true)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return ((data ?? []) as unknown as CatalogRow[]).map((row) => {
    const category = categoryFor(categoryName(row));
    const price = Number(row.price);
    return {
      id: row.id,
      name: row.name,
      description: row.description ?? "",
      category,
      price: Number.isFinite(price) ? price : 0,
      unit: row.unit_label ?? "unité",
      image: row.image_url || fallbackImage(category),
      available: row.active
    };
  });
}
