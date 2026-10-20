import { supabase } from "../lib/supabase";

export type DocType = "delivery_note" | "invoice" | "credit_note" | "return";
export type Numbering = { doc_type: DocType; prefix: string; with_year: boolean; digits: number; next_number: number; yearly_reset: boolean };

export const docTypeLabels: Record<DocType, string> = {
  delivery_note: "Bons de livraison",
  invoice: "Factures",
  credit_note: "Avoirs",
  return: "Retours",
};

// Same rule as format_document_number in the database.
export const previewNumber = (item: Pick<Numbering, "prefix" | "with_year" | "digits" | "next_number">) =>
  `${item.prefix}${item.with_year ? `${new Date().getFullYear()}-` : ""}${String(item.next_number).padStart(item.digits, "0")}`;

export async function fetchNumbering(): Promise<Numbering[]> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { data, error } = await supabase.from("document_numbering").select("doc_type, prefix, with_year, digits, next_number, yearly_reset").order("doc_type");
  if (error) throw error;
  return (data ?? []) as Numbering[];
}

export async function saveNumbering(item: Numbering): Promise<void> {
  if (!supabase) throw new Error("Supabase n’est pas configuré.");
  const { error } = await supabase.rpc("admin_set_numbering", {
    p_type: item.doc_type, p_prefix: item.prefix, p_with_year: item.with_year, p_digits: item.digits, p_next_number: item.next_number, p_yearly_reset: item.yearly_reset,
  });
  if (error) throw error;
}
