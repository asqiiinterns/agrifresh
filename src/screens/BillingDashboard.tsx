import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { balanceOf, isOverdue, paymentMethodLabel, type InvoiceWithOrders } from "../data/invoices";
import type { CreditNote } from "../data/returns";
import { Button, Chip, formatPrice } from "../ui/components";
import { invoicesCsv, paymentsCsv, salesJournalCsv, saveCsv } from "../data/exports";
import { presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { useModules } from "../data/modules";
import { appLocale } from "../ui/i18n";

const monthKey = (value: string) => value.slice(0, 7);
const monthLabel = (key: string) => new Date(`${key}-15T12:00:00`).toLocaleDateString(appLocale(), { month: "short" });
const shortAmount = (value: number) => value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)} k` : value.toFixed(0);

// Billing figures: headline tiles, then one single-series chart per question (no dual axis).
export function BillingDashboard({ invoices, credits }: { invoices: InvoiceWithOrders[]; credits: CreditNote[] }) {
  const exportsOn = useModules()("exports");
  const data = useMemo(() => {
    const valid = invoices.filter((invoice) => invoice.status === "issued" || invoice.status === "paid");
    const thisMonth = new Date().toISOString().slice(0, 7);
    const months = Array.from({ length: 6 }, (_, index) => {
      const date = new Date();
      date.setDate(15);
      date.setMonth(date.getMonth() - (5 - index));
      return date.toISOString().slice(0, 7);
    });
    const payments = valid.flatMap((invoice) => (invoice.invoice_payments ?? []).map((payment) => ({ ...payment, client: invoice.client_snapshot.business_name })));
    const invoiced = months.map((key) => ({ key, label: monthLabel(key), value: valid.filter((invoice) => monthKey(invoice.issued_at) === key).reduce((sum, invoice) => sum + Number(invoice.total_ttc), 0) }));
    const collected = months.map((key) => ({ key, label: monthLabel(key), value: payments.filter((payment) => monthKey(payment.paid_on) === key).reduce((sum, payment) => sum + Number(payment.amount), 0) }));
    const since = new Date();
    since.setDate(since.getDate() - 90);
    const byMethod = new Map<string, number>();
    for (const payment of payments.filter((item) => item.paid_on >= since.toISOString().slice(0, 10))) byMethod.set(payment.method, (byMethod.get(payment.method) ?? 0) + Number(payment.amount));
    const byClient = new Map<string, number>();
    for (const invoice of valid.filter((item) => item.status === "issued")) byClient.set(invoice.client_snapshot.business_name, (byClient.get(invoice.client_snapshot.business_name) ?? 0) + balanceOf(invoice));
    const overdue = valid.filter(isOverdue);
    return {
      invoicedMonth: invoiced.at(-1)?.value ?? 0,
      collectedMonth: collected.at(-1)?.value ?? 0,
      outstanding: valid.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum + balanceOf(invoice), 0),
      overdueAmount: overdue.reduce((sum, invoice) => sum + balanceOf(invoice), 0),
      overdueCount: overdue.length,
      creditsMonth: credits.filter((credit) => credit.issued_at && monthKey(credit.issued_at) === thisMonth && credit.status !== "cancelled").reduce((sum, credit) => sum + Number(credit.total_ttc), 0),
      invoiced,
      collected,
      methods: [...byMethod.entries()].map(([key, value]) => ({ key, label: paymentMethodLabel(key), value })).sort((a, b) => b.value - a.value),
      clients: [...byClient.entries()].map(([key, value]) => ({ key, label: key, value })).sort((a, b) => b.value - a.value).slice(0, 5),
    };
  }, [invoices, credits]);

  return <ScrollView contentContainerStyle={ui.content}>
    <View style={styles.tiles}>
      <Tile label="Facturé ce mois" value={formatPrice(data.invoicedMonth)} />
      <Tile label="Encaissé ce mois" value={formatPrice(data.collectedMonth)} />
      <Tile label="Reste à encaisser" value={formatPrice(data.outstanding)} />
      <Tile label={`En retard (${data.overdueCount})`} value={formatPrice(data.overdueAmount)} warn={data.overdueCount > 0} />
      <Tile label="Avoirs ce mois" value={formatPrice(data.creditsMonth)} />
    </View>
    <ColumnChart title="Facturé TTC par mois" points={data.invoiced} />
    <ColumnChart title="Encaissé par mois" points={data.collected} />
    <BarList title="Encaissements par mode (90 jours)" points={data.methods} empty="Aucun règlement enregistré sur 90 jours." />
    <BarList title="Clients : reste à encaisser" points={data.clients} empty="Aucune facture à encaisser." />
    {exportsOn ? <ExportsCard invoices={invoices} credits={credits} /> : null}
  </ScrollView>;
}

// Excel and accounting exports for a period.
function ExportsCard({ invoices, credits }: { invoices: InvoiceWithOrders[]; credits: CreditNote[] }) {
  const [period, setPeriod] = useState<DateFilterValue>(() => presets.thisMonth.value());
  const [busy, setBusy] = useState<string | null>(null);
  const from = period?.from ?? "2000-01-01";
  const to = period?.to ?? "2100-12-31";
  async function run(key: string, name: string, content: () => string) {
    setBusy(key);
    try {
      await saveCsv(`${name}-${from}-${to}.csv`, content());
    } catch (cause) {
      notify("Export", errorMessage(cause, "Export impossible."));
    } finally {
      setBusy(null);
    }
  }
  return <View style={ui.card}>
    <Text style={ui.strong}>Exports</Text>
    <Text style={ui.small}>Fichiers CSV qui s’ouvrent dans Excel (séparateur « ; »), à envoyer au comptable.</Text>
    <View style={[ui.wrapRow, { marginTop: 8 }]}>
      {[presets.thisMonth, presets.lastMonth, presets.last30].map((preset) => <Chip key={preset.label} label={preset.label} selected={period?.label === preset.label} onPress={() => setPeriod(preset.value())} />)}
      <Chip label="Tout" selected={period === null} onPress={() => setPeriod(null)} />
    </View>
    <View style={[ui.wrapRow, { marginTop: 8 }]}>
      <Button label="FACTURES" variant="secondary" busy={busy === "invoices"} onPress={() => run("invoices", "factures", () => invoicesCsv(invoices, from, to))} />
      <Button label="RÈGLEMENTS" variant="secondary" busy={busy === "payments"} onPress={() => run("payments", "reglements", () => paymentsCsv(invoices, from, to))} />
      <Button label="JOURNAL DES VENTES" variant="secondary" busy={busy === "journal"} onPress={() => run("journal", "journal-ventes", () => salesJournalCsv(invoices, credits, from, to))} />
    </View>
    <Text style={[ui.small, { marginTop: 6 }]}>Journal : 411 clients, 706 ventes, 4457 TVA collectée, 4458 timbre, 709 avoirs. À faire valider par votre comptable.</Text>
  </View>;
}

export function Tile({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return <View style={[styles.tile, warn && styles.tileWarn]}>
    <Text style={styles.tileValue} numberOfLines={1}>{value}</Text>
    <Text style={styles.tileLabel}>{label}</Text>
  </View>;
}

export type Point = { key: string; label: string; value: number };

// Vertical bars over the last months; tap a bar to read its exact value.
export function ColumnChart({ title, points, format = formatPrice }: { title: string; points: Point[]; format?: (value: number) => string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const max = Math.max(1, ...points.map((point) => point.value));
  const chosen = points.find((point) => point.key === selected) ?? points.at(-1);
  return <View style={ui.card}>
    <View style={ui.row}>
      <Text style={ui.strong}>{title}</Text>
      {chosen ? <Text style={ui.small}>{chosen.label} : <Text style={{ fontWeight: "800", color: colors.text }}>{format(chosen.value)}</Text></Text> : null}
    </View>
    <View style={styles.columns} accessibilityLabel={`${title} : ${points.map((point) => `${point.label} ${format(point.value)}`).join(", ")}`}>
      {points.map((point) => {
        const active = point.key === (chosen?.key ?? "");
        return <Pressable key={point.key} onPress={() => setSelected(point.key)} style={styles.columnSlot} hitSlop={4}>
          <Text style={styles.columnValue}>{point.value ? shortAmount(point.value) : ""}</Text>
          <View style={styles.columnTrack}>
            <View style={[styles.column, { height: `${(point.value / max) * 100}%`, opacity: active ? 1 : 0.55 }]} />
          </View>
          <Text style={[styles.columnLabel, active && { color: colors.text, fontWeight: "800" }]}>{point.label}</Text>
        </Pressable>;
      })}
    </View>
  </View>;
}

// Horizontal bars, each labelled with its name and value.
export function BarList({ title, points, empty, format = formatPrice }: { title: string; points: Point[]; empty: string; format?: (value: number) => string }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  return <View style={ui.card}>
    <Text style={ui.strong}>{title}</Text>
    {points.length === 0 ? <Text style={[ui.small, { marginTop: 6 }]}>{empty}</Text> : points.map((point) => <View key={point.key} style={{ marginTop: 8 }}>
      <View style={ui.row}>
        <Text style={[ui.body, { flex: 1 }]} numberOfLines={1}>{point.label}</Text>
        <Text style={[ui.body, { fontWeight: "800" }]}>{format(point.value)}</Text>
      </View>
      <View style={styles.barTrack}><View style={[styles.bar, { width: `${(point.value / max) * 100}%` }]} /></View>
    </View>)}
  </View>;
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  tile: { flexBasis: "47%", flexGrow: 1, backgroundColor: colors.white, borderRadius: 10, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 10, paddingVertical: 8 },
  tileWarn: { borderColor: "#e3c46f", backgroundColor: "#fffbef" },
  tileValue: { color: colors.text, fontSize: 16, fontWeight: "800" },
  tileLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", marginTop: 1 },
  columns: { flexDirection: "row", alignItems: "flex-end", height: 150, marginTop: 10, gap: 2 },
  columnSlot: { flex: 1, alignItems: "center", height: "100%" },
  columnValue: { color: colors.muted, fontSize: 9, height: 13 },
  columnTrack: { flex: 1, width: "70%", justifyContent: "flex-end", borderBottomWidth: 1, borderBottomColor: colors.line },
  column: { backgroundColor: colors.primary, borderTopLeftRadius: 4, borderTopRightRadius: 4, minHeight: 1 },
  columnLabel: { color: colors.muted, fontSize: 10, marginTop: 4, textTransform: "capitalize" },
  barTrack: { height: 8, borderRadius: 4, backgroundColor: colors.cream, marginTop: 3, overflow: "hidden" },
  bar: { height: 8, borderRadius: 4, backgroundColor: colors.primary },
});
