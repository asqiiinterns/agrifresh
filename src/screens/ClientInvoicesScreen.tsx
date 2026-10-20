import { useEffect, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { fetchInvoices, invoiceLabel, shareInvoice, type InvoiceWithOrders } from "../data/invoices";
import { fetchBuyerInvoices, withSeller, type BuyerInvoice } from "../data/buyer";
import { deliveryNoteNumber } from "../data/orders";
import { Button, Chip, EmptyState, Loading, ScreenHeader, formatDay, formatPrice } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { Sheets } from "../ui/components";
import { useCan } from "../data/permissions";
import { fetchCreditNotes, fetchReturns, type CreditNote, type ProductReturn } from "../data/returns";
import { ClientReturnsList, CreditsList } from "./ReturnsScreen";
import { InvoiceBadge } from "./StaffInvoicesScreen";
import { ClientAccountSheet } from "./AccountsScreens";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";

const filters = [
  { key: "all", label: "Toutes" },
  { key: "issued", label: "À régler" },
  { key: "paid", label: "Réglées" },
] as const;

// RLS returns only this client's issued, paid or cancelled invoices (never drafts).
// Invoices of all my suppliers (20261117), each printed with its own supplier's details.
function InvoiceList() {
  const [invoices, setInvoices] = useState<(InvoiceWithOrders & Partial<Pick<BuyerInvoice, "supplier_name" | "seller">>)[]>([]);
  const [supplier, setSupplier] = useState<string>("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [issued, setIssued] = useState<DateFilterValue>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setInvoices(await fetchBuyerInvoices() ?? await fetchInvoices());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger vos factures."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function open(invoice: InvoiceWithOrders & { seller?: BuyerInvoice["seller"] }) {
    setOpeningId(invoice.id);
    try {
      await withSeller(invoice.seller, () => shareInvoice(invoice));
    } catch (cause) {
      notify("Facture", errorMessage(cause, "Impossible d’afficher la facture."));
    } finally {
      setOpeningId(null);
    }
  }

  const suppliers = [...new Map(invoices.filter((invoice) => invoice.supplier_name).map((invoice) => [invoice.client_id, invoice.supplier_name as string]))];
  const multi = suppliers.length > 1;
  const visible = invoices.filter((invoice) => (supplier === "all" || invoice.client_id === supplier) && (filter === "all" || invoice.status === filter) && matchesDate(invoice.issued_at, issued));
  const listFilters: Filter[] = [
    { kind: "choice", title: "Statut", options: filters.map((item) => ({ key: item.key, label: item.label })), value: filter, defaultValue: "all", onChange: setFilter },
    { kind: "date", title: "Émise le", presets: [presets.last7, presets.last30, presets.thisMonth, presets.lastMonth], value: issued, onChange: setIssued },
    ...(multi ? [{ kind: "choice" as const, title: "Fournisseur", options: [{ key: "all", label: "Tous les fournisseurs" }, ...suppliers.map(([key, label]) => ({ key, label }))], value: supplier, defaultValue: "all", onChange: setSupplier }] : []),
  ];
  const due = invoices.filter((invoice) => invoice.status === "issued" && (supplier === "all" || invoice.client_id === supplier))
    .reduce((sum, invoice) => sum + Number(invoice.total_ttc) - Number(invoice.amount_paid ?? 0), 0);

  return <View style={{ flex: 1 }}>
    <FilterBar filters={listFilters} />
    {due ? <Text style={[ui.small, { paddingHorizontal: 14, marginTop: 6, color: colors.text, fontWeight: "800" }]}>À régler : {formatPrice(due)}</Text> : null}
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(invoice) => invoice.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune facture" body="Vos factures apparaîtront ici." />}
      renderItem={({ item }) => <View style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{invoiceLabel(item)}</Text>
          <InvoiceBadge status={item.status} />
        </View>
        {multi && item.supplier_name ? <Text style={[ui.small, { fontWeight: "700" }]}>{item.supplier_name}</Text> : null}
        <Text style={ui.small}>Émise le {formatDay(item.issued_at, { day: "numeric", month: "long", year: "numeric" })}{item.paid_at ? ` · réglée le ${formatDay(item.paid_at, { day: "numeric", month: "long" })}` : ""}</Text>
        <Text style={ui.small}>{[...item.orders].sort((a, b) => a.order_number - b.order_number).map(deliveryNoteNumber).join(", ")}</Text>
        <View style={[ui.row, ui.divider]}>
          <Text style={ui.strong}>Net à payer TTC</Text>
          <Text style={ui.amount}>{formatPrice(item.total_ttc)}</Text>
        </View>
        <Button label="VOIR LA FACTURE" variant="secondary" onPress={() => open(item)} busy={openingId === item.id} style={{ marginTop: 10, alignSelf: "flex-start" }} />
      </View>}
    />}
  </View>;
}

// Mes factures: invoices, credit notes and returns, as sheets.
export function ClientInvoicesScreen({ initialSheet, onSheet }: { initialSheet?: string; onSheet?: (sheet: string) => void } = {}) {
  const canReturns = useCan()("client.returns");
  type Sheet = "invoices" | "account" | "credits" | "returns";
  const [sheet, setSheet] = useState<Sheet>(initialSheet === "credits" || initialSheet === "account" || (initialSheet === "returns" && canReturns) ? initialSheet as Sheet : "invoices");
  const [credits, setCredits] = useState<CreditNote[]>([]);
  const [returns, setReturns] = useState<ProductReturn[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  async function reloadDocuments(refresh = false) {
    if (refresh) setRefreshing(true);
    try {
      const [nextCredits, nextReturns] = await Promise.all([fetchCreditNotes().catch(() => []), canReturns ? fetchReturns().catch(() => []) : Promise.resolve([])]);
      setCredits(nextCredits);
      setReturns(nextReturns);
    } finally {
      setRefreshing(false);
    }
  }
  useEffect(() => { void reloadDocuments(); }, []);
  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reloadDocuments(true)} tintColor={colors.primary} />;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="VOS DOCUMENTS" title="Mes factures" />
    <Sheets
      items={[{ key: "invoices", label: "Factures" }, { key: "account", label: "Mon compte" }, { key: "credits", label: "Avoirs", count: credits.length || undefined }, ...(canReturns ? [{ key: "returns" as const, label: "Retours", count: returns.filter((item) => item.status !== "credited" && item.status !== "refused").length || undefined }] : [])]}
      value={sheet}
      onChange={(next) => { setSheet(next); onSheet?.(next); }}
    />
    {sheet === "invoices" ? <InvoiceList /> : sheet === "account" ? <ClientAccountSheet /> : sheet === "credits" ? <CreditsList credits={credits} refreshControl={refresh} onChanged={() => void reloadDocuments()} /> : <ClientReturnsList returns={returns} refreshControl={refresh} />}
  </View>;
}

const styles = StyleSheet.create({
  filters: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
});
