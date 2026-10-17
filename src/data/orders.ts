import { supabase } from "../lib/supabase";
import type { CartLine } from "../types/order";

export type DeliveryAddress = {
  recipient_name: string;
  phone: string;
  address_line: string;
  city: string;
  notes?: string;
};

export type PlacedOrder = {
  id: string;
  order_number: number;
  subtotal: number;
  delivery_fee: number;
  total: number;
  currency: string;
  status: string;
  payment_method: string;
};

export type CustomerOrder = {
  id: string;
  order_number: number;
  status: string;
  total: number | string;
  currency: string;
  created_at: string;
  order_items: {
    product_name_snapshot: string;
    quantity: number | string;
    unit_snapshot: string;
    line_total: number | string;
  }[];
};

export async function placeCustomerOrder(
  cart: CartLine[],
  address: DeliveryAddress,
  customerNote = ""
): Promise<PlacedOrder> {
  if (!supabase) throw new Error("La connexion au service de commande n’est pas configurée.");

  const { data, error } = await supabase.rpc("place_customer_order", {
    p_items: cart.map(({ product, quantity }) => ({ product_id: product.id, quantity })),
    p_address: address,
    p_customer_note: customerNote.trim() || null,
  });

  if (error) throw error;
  return data as PlacedOrder;
}

export async function fetchCustomerOrders(): Promise<CustomerOrder[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");

  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status, total, currency, created_at, order_items(product_name_snapshot, quantity, unit_snapshot, line_total)")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return (data ?? []) as unknown as CustomerOrder[];
}
