import { supabase } from "../lib/supabase";

export async function fetchFavoriteIds(): Promise<string[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase.from("customer_favorites").select("product_id");
  if (error) throw error;
  return (data ?? []).map((row) => row.product_id);
}

export async function setFavorite(customerId: string, productId: string, isFavorite: boolean): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");

  if (isFavorite) {
    const { error } = await supabase.from("customer_favorites").upsert(
      { customer_id: customerId, product_id: productId },
      { onConflict: "customer_id,product_id", ignoreDuplicates: true }
    );
    if (error) throw error;
  } else {
    const { error } = await supabase.from("customer_favorites").delete().eq("product_id", productId);
    if (error) throw error;
  }
}
