import { supabase } from "../lib/supabase";
import { QR, qrSvg } from "../ui/Qr";
import { documentStyles, escapeHtml, outputPdf, pdfAmount, pdfDate, pdfQuantity, sellerBlock } from "./pdf";

export type OrderLine = {
  product_id: string | null;
  product_name_snapshot: string;
  quantity: number | string;
  unit_snapshot: string;
  unit_price: number | string;
  line_total: number | string;
  vat_rate: number | string;
};

export type Order = {
  id: string;
  order_number: number;
  status: string;
  status_note: string | null;
  total: number | string;
  currency: string;
  created_at: string;
  requested_delivery_date: string | null;
  delivered_at: string | null;
  customer_note: string | null;
  client_id: string | null;
  delivery_point_id: string | null;
  delivery_token: string;
  client_invoice_id: string | null;
  address_snapshot: {
    business_name?: string;
    recipient_name?: string;
    phone?: string;
    point_label?: string;
    address_line?: string;
    city?: string;
    notes?: string | null;
  };
  order_items: OrderLine[];
};

export const ORDER_FIELDS = "id, order_number, status, status_note, total, currency, created_at, requested_delivery_date, delivered_at, customer_note, client_id, delivery_point_id, delivery_token, client_invoice_id, address_snapshot, order_items(product_id, product_name_snapshot, quantity, unit_snapshot, unit_price, line_total, vat_rate)";

export type OrderDraftLine = { product_id: string; quantity: number };

export async function placeClientOrder(params: {
  items: OrderDraftLine[];
  deliveryPointId: string | null;
  requestedDate: string | null;
  note: string;
}): Promise<{ id: string; order_number: number; total: number }> {
  if (!supabase) throw new Error("La connexion au service de commande n’est pas configurée.");
  const { data, error } = await supabase.rpc("place_client_order", {
    p_items: params.items,
    p_delivery_point_id: params.deliveryPointId,
    p_requested_date: params.requestedDate,
    p_note: params.note.trim() || null,
  });
  if (error) throw error;
  return data as { id: string; order_number: number; total: number };
}

// RLS limits customers to their own orders.
export async function fetchMyOrders(): Promise<Order[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase
    .from("orders")
    .select(ORDER_FIELDS)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as Order[];
}

export const deliveryNoteNumber = (order: Pick<Order, "order_number">) => `BL-${String(order.order_number).padStart(6, "0")}`;

// Delivery note: one per order. Its QR code is scanned by the driver at hand-over.
export async function shareDeliveryNote(order: Order, showPrices: boolean): Promise<void> {
  const number = deliveryNoteNumber(order);
  const address = order.address_snapshot ?? {};
  const lines = order.order_items.map((line) => `
    <tr>
      <td>${escapeHtml(line.product_name_snapshot)}</td>
      <td class="number">${pdfQuantity(line.quantity)}</td>
      <td>${escapeHtml(line.unit_snapshot)}</td>
      ${showPrices ? `<td class="number">${pdfAmount(line.unit_price)}</td><td class="number">${pdfAmount(line.line_total)}</td>` : ""}
    </tr>`).join("");

  const html = `<!doctype html><html lang="fr"><head><meta charset="utf-8" /><style>${documentStyles}</style></head><body>
    <div class="top">
      <div><h1>AgriFresh</h1><div class="muted">Le goût du naturel</div></div>
      <div class="doc"><strong>BON DE LIVRAISON</strong><br/>${number}<br/><span class="muted">Commande #${order.order_number} du ${pdfDate(order.created_at)}</span>
        ${order.requested_delivery_date ? `<br/><span class="muted">Livraison souhaitée : ${pdfDate(order.requested_delivery_date)}</span>` : ""}</div>
      <div class="qr">${qrSvg(QR.deliveryNote(order.delivery_token))}</div>
    </div>
    <div class="parties">
      ${sellerBlock()}
      <div class="party"><strong>${escapeHtml(address.business_name ?? address.recipient_name ?? "")}</strong>${address.point_label ? ` · ${escapeHtml(address.point_label)}` : ""}<br/>
        ${escapeHtml(address.address_line ?? "")}, ${escapeHtml(address.city ?? "")}${address.phone ? `<br/>${escapeHtml(address.phone)}` : ""}
        ${address.notes ? `<br/><span class="muted">${escapeHtml(address.notes)}</span>` : ""}</div>
    </div>
    <table><thead><tr><th>Produit</th><th class="number">Quantité</th><th>Unité</th>${showPrices ? `<th class="number">Prix unitaire HT</th><th class="number">Total HT</th>` : ""}</tr></thead><tbody>${lines}</tbody></table>
    ${showPrices ? `<div class="totals"><div class="row grand"><span>Total HT</span><span>${pdfAmount(order.total)} TND</span></div></div>` : ""}
    ${order.customer_note ? `<div class="note"><strong>Remarque du client :</strong> ${escapeHtml(order.customer_note)}</div>` : ""}
    <div class="signatures"><div>Livré par</div><div>Reçu par (nom, signature)</div></div>
    <div class="note">Le livreur scanne le QR code de ce bon puis le QR code du client pour confirmer la livraison. Ce bon n’est pas une facture.</div>
  </body></html>`;

  await outputPdf(html, number, `Bon de livraison ${number}`);
}
