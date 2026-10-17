import { supabase } from "../lib/supabase";
import type { CustomerOrder } from "./orders";

export type OrderStatus = "pending" | "confirmed" | "preparing" | "ready" | "out_for_delivery" | "delivered" | "cancelled";

export const nextStatus: Partial<Record<OrderStatus, { status: OrderStatus; label: string }>> = {
  pending: { status: "confirmed", label: "VALIDER LA COMMANDE" },
  confirmed: { status: "preparing", label: "PASSER EN PRÉPARATION" },
  preparing: { status: "ready", label: "MARQUER PRÊTE" },
  ready: { status: "out_for_delivery", label: "METTRE EN LIVRAISON" },
  out_for_delivery: { status: "delivered", label: "MARQUER LIVRÉE" },
};

export const isOpenStatus = (status: string) => status !== "delivered" && status !== "cancelled";

// Without the staff migration the RPC is missing; treat that as a customer account.
export async function fetchIsStaff(): Promise<boolean> {
  if (!supabase) return false;
  const { data, error } = await supabase.rpc("is_staff");
  if (error) return false;
  return data === true;
}

export async function fetchAllOrders(): Promise<CustomerOrder[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");

  const { data, error } = await supabase
    .from("orders")
    .select("id, order_number, status, total, currency, created_at, customer_note, address_snapshot, order_items(product_name_snapshot, quantity, unit_snapshot, line_total), invoices(invoice_number, issued_at, subtotal, tax_total, delivery_fee, total, currency)")
    .order("created_at", { ascending: false })
    .limit(200);

  if (error) throw error;
  return (data ?? []) as unknown as CustomerOrder[];
}

export async function updateOrderStatus(orderId: string, status: OrderStatus, note?: string): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { error } = await supabase.rpc("staff_update_order_status", {
    p_order_id: orderId,
    p_status: status,
    p_note: note?.trim() || null,
  });
  if (error) throw error;
}
