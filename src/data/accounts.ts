import { supabase } from "../lib/supabase";
import { paymentMethodLabel } from "./invoices";

// Accounts between a supplier and its clients: deposits, statement, outstanding limit (20261114_accounts.sql).
export type AccountFigures = { outstanding: number; deposits: number; credit_limit: number | null };
export type AccountSummary = AccountFigures & { client_id: string; business_name: string };
export type StatementLine = {
  date: string; sort: string; kind: "invoice" | "payment" | "deposit_use" | "deposit" | "refund" | "credit_note";
  label: string; ref: string | null; method?: string; debit: number; credit: number; info?: number;
};
export type Statement = { client_id: string; business_name: string; supplier_name: string | null; figures: AccountFigures; lines: StatementLine[] };
export type DepositMethod = "cash" | "check" | "transfer" | "card" | "other";

function client() {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  return supabase;
}
async function call<T>(name: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client().rpc(name, args);
  if (error) throw error;
  return data as T;
}

export const fetchAccounts = () => call<AccountSummary[]>("staff_accounts");
export const fetchStatement = (clientId?: string) => call<Statement>("account_statement", clientId ? { p_client_id: clientId } : {});
export const recordDeposit = (clientId: string, kind: "deposit" | "refund", amount: number, method: DepositMethod, entryDate: string | null, reference: string, note: string) =>
  call<AccountFigures>("staff_record_deposit", { p_client_id: clientId, p_kind: kind, p_amount: amount, p_method: method, p_entry_date: entryDate || null, p_reference: reference, p_note: note });
export const applyDeposit = (invoiceId: string, amount: number) => call<AccountFigures>("staff_apply_deposit", { p_invoice_id: invoiceId, p_amount: amount });
export const setCreditLimit = (clientId: string, limit: number | null) => call<void>("staff_set_credit_limit", { p_client_id: clientId, p_limit: limit });

// What the client still owes once its available deposits are counted (negative: in its favour).
export const netBalance = (figures: AccountFigures) => Number(figures.outstanding) - Number(figures.deposits);
export const overLimit = (figures: AccountFigures) => figures.credit_limit !== null && netBalance(figures) >= Number(figures.credit_limit);

// Running balance, oldest line first: invoices and refunds raise it, payments, deposits and credit notes lower it.
export function withBalance(lines: StatementLine[]) {
  let balance = 0;
  return lines.map((line) => {
    balance += Number(line.debit) - Number(line.credit);
    return { ...line, balance };
  });
}

// Built here rather than in SQL so that it follows the app's language.
export function lineLabel(line: StatementLine) {
  const ref = line.ref ?? "";
  switch (line.kind) {
    case "invoice": return `Facture ${ref}`;
    case "payment": return line.method ? `Règlement ${ref} · ${paymentMethodLabel(line.method)}` : `Règlement ${ref}`;
    case "deposit_use": return `Acompte imputé sur ${ref}`;
    case "deposit": return ref ? `Acompte reçu · ${ref}` : "Acompte reçu";
    case "refund": return ref ? `Acompte remboursé · ${ref}` : "Acompte remboursé";
    case "credit_note": return `Avoir ${ref}`;
    default: return line.label;
  }
}
