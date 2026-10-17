import { supabase } from "../lib/supabase";

export type Shipment = {
  id: string;
  order_number: number;
  requested_delivery_date: string | null;
  total: number | string;
  business_name: string;
  point_label: string;
  address_line: string;
  city: string;
  phone: string;
  item_count: number;
};

export type ScannedPoint = {
  point: { id: string; label: string; address_line: string; city: string; business_name: string; client_number: number };
  orders: {
    id: string;
    order_number: number;
    requested_delivery_date: string | null;
    total: number | string;
    items: { name: string; quantity: number | string; unit: string }[];
  }[];
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export async function fetchShipments(): Promise<Shipment[]> {
  const { data, error } = await client().rpc("driver_shipments");
  if (error) throw error;
  return (data ?? []) as Shipment[];
}

export async function lookupDeliveryPoint(qrToken: string): Promise<ScannedPoint> {
  const { data, error } = await client().rpc("driver_lookup_point", { p_qr_token: qrToken });
  if (error) throw error;
  return data as ScannedPoint;
}

export async function confirmDelivery(qrToken: string, orderIds: string[]): Promise<number> {
  const { data, error } = await client().rpc("driver_confirm_delivery", { p_qr_token: qrToken, p_order_ids: orderIds });
  if (error) throw error;
  return Number(data);
}
