import { supabase } from "../lib/supabase";
import { applyCompanyProfile, company, type CompanyProfile } from "../config/company";
import type { AccountFigures } from "./accounts";
import type { Attachment } from "./attachments";
import type { InvoiceWithOrders } from "./invoices";
import type { Message } from "./messages";
import type { OrderDraftLine } from "./orders";

// A buyer with several suppliers (20261117_buyer_journey.sql). Functions returning null mean
// "migration not run yet": screens then keep their single-supplier behaviour.

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}
async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(name, args);
  if (error) throw error;
  return data as T;
}
async function optional<T>(name: string, args?: Record<string, unknown>): Promise<T | null> {
  if (!supabase) return null;
  const { data, error } = await supabase.rpc(name, args);
  return error ? null : data as T;
}

// One reception QR per buyer, valid with all its suppliers.
export type ReceptionQr = { token: string; name: string; required: boolean };
export const fetchReceptionQr = () => optional<ReceptionQr>("my_reception_qr");

// Invoices and accounts of all my suppliers.
export type Seller = { name: string; tagline: string; address: string; phone: string; email: string; tax_id: string; rib: string; brand_color: string };
export type BuyerInvoice = InvoiceWithOrders & { supplier_name: string; seller: Seller };
export const fetchBuyerInvoices = () => optional<BuyerInvoice[]>("buyer_invoices");
export type BuyerAccount = AccountFigures & { client_id: string; supplier_name: string; current: boolean };
export const fetchBuyerAccounts = () => optional<BuyerAccount[]>("buyer_accounts");

// Prints a document with another supplier's details, then puts mine back.
export async function withSeller<T>(seller: Seller | undefined, print: () => Promise<T>): Promise<T> {
  if (!seller) return print();
  const saved: CompanyProfile = { ...company };
  applyCompanyProfile({ name: seller.name, tagline: seller.tagline, address: seller.address, phone: seller.phone, email: seller.email, taxId: seller.tax_id, rib: seller.rib, brandColor: seller.brand_color });
  try {
    return await print();
  } finally {
    applyCompanyProfile(saved);
  }
}

// An order the supplier has not accepted yet: cancel it or change its lines.
export const cancelOrder = (orderId: string, reason?: string) => call<{ id: string; status: string }>("client_cancel_order", { p_order_id: orderId, p_reason: reason ?? null });
export const modifyOrder = (orderId: string, items: OrderDraftLine[], note: string | null) =>
  call<{ id: string; order_number: number; total: number }>("client_modify_order", { p_order_id: orderId, p_items: items, p_note: note });

// Messages: one conversation per supplier.
export type BuyerConversation = { client_id: string; supplier_name: string; last_body: string | null; last_at: string | null; last_from_staff: boolean | null; unread: number };
export const fetchBuyerInbox = () => optional<BuyerConversation[]>("buyer_inbox");
export const fetchBuyerThread = (clientId: string) => call<Message[]>("buyer_thread", { p_client_id: clientId });
export const buyerSendMessage = (clientIds: string[], body: string, attachment: Attachment | null = null, needsReply = false, replyTo: string | null = null) =>
  call<Message[]>("buyer_send_message", { p_client_ids: clientIds, p_body: body.trim(), p_attachment: attachment, p_needs_reply: needsReply, p_reply_to: replyTo });
export const staffSendMessages = (clientIds: string[], body: string, needsReply = false) =>
  call<Message[]>("staff_send_messages", { p_client_ids: clientIds, p_body: body.trim(), p_needs_reply: needsReply });

// Outstanding figures of a client, for the supplier entering an order for it.
export const fetchStaffClientFigures = (clientId: string) => optional<AccountFigures>("staff_client_figures", { p_client_id: clientId });
