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
  client_id: string;
  point_id: string;
  reception_qr: boolean;
  scan_delivery_note: boolean;
  scan_client_qr: boolean;
  shipment_number: number | null;
  vehicle_label: string | null;
  driver_name: string | null;
};

export type ScannedDeliveryNote = {
  id: string;
  order_number: number;
  delivery_token: string;
  client_id: string;
  business_name: string;
  reception_qr: boolean;
  scan_delivery_note: boolean;
  scan_client_qr: boolean;
  point_id: string;
  point_label: string;
  address_line: string;
  city: string;
  items: { name: string; quantity: number | string; unit: string }[];
};

export type DeliveredOrder = {
  id: string;
  order_number: number;
  delivered_at: string;
  client_id: string;
  business_name: string;
  point_label: string;
  address_line: string;
  city: string;
  total: number | string;
  driver_name: string | null;
  item_count: number;
  shipment_number: number | null;
  vehicle_label: string | null;
};

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}

export type Pickup = {
  id: string;
  order_number: number;
  client_id: string;
  requested_delivery_date: string | null;
  business_name: string;
  point_label: string;
  address_line: string;
  city: string;
  phone: string;
  items: { name: string; quantity: number | string; unit: string }[];
};

// Orders prepared and waiting for the driver.
export async function fetchPickups(): Promise<Pickup[]> {
  const { data, error } = await client().rpc("driver_pickups");
  if (error) throw error;
  return (data ?? []) as Pickup[];
}

export async function fetchShipments(): Promise<Shipment[]> {
  const { data, error } = await client().rpc("driver_shipments");
  if (error) throw error;
  return (data ?? []) as Shipment[];
}

export async function lookupDeliveryNote(deliveryToken: string): Promise<ScannedDeliveryNote> {
  const { data, error } = await client().rpc("driver_lookup_delivery", { p_delivery_token: deliveryToken });
  if (error) throw error;
  return data as ScannedDeliveryNote;
}

// Hand-over: the scanned delivery notes plus the client's QR code (wall sticker or reception code).
export async function confirmHandover(deliveryTokens: string[], clientQr: { kind: "point" | "client"; token: string }): Promise<number> {
  const { data, error } = await client().rpc("driver_confirm_handover", {
    p_delivery_tokens: deliveryTokens,
    p_client_qr_kind: clientQr.kind,
    p_client_qr_token: clientQr.token,
  });
  if (error) throw error;
  return Number(data);
}

export async function fetchDeliveryHistory(since: string): Promise<DeliveredOrder[]> {
  const { data, error } = await client().rpc("driver_history", { p_since: since });
  if (error) throw error;
  return (data ?? []) as DeliveredOrder[];
}
