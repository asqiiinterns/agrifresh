import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatClientNumber } from "../data/account";
import { fetchClients, type ClientRecord } from "../data/clients";
import { createInvoice, fetchInvoices, fetchUninvoicedOrders, invoiceTotals, setInvoiceStatus, shareInvoice, type InvoiceWithOrders } from "../data/invoices";
import { deliveryNoteNumber, type Order } from "../data/orders";
import { Button, Chip, CloseButton, EmptyState, Loading, ScreenHeader, StatusBadge, formatDay, formatPrice } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

const statusFilters = [
  { key: "all", label: "Toutes" },
  { key: "issued", label: "À encaisser" },
  { key: "paid", label: "Payées" },
  { key: "cancelled", label: "Annulées" },
] as const;

const invoiceStatus = {
  issued: { label: "À encaisser", color: colors.amber, background: "#fdf3e1" },
  paid: { label: "Payée", color: colors.green, background: "#dcebd7" },
  cancelled: { label: "Annulée", color: colors.danger, background: "#f8e5e1" },
};

function InvoiceBadge({ status }: { status: InvoiceWithOrders["status"] }) {
  const style = invoiceStatus[status];
  return <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>;
}

export function StaffInvoicesScreen() {
  const [invoices, setInvoices] = useState<InvoiceWithOrders[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<(typeof statusFilters)[number]["key"]>("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      setInvoices(await fetchInvoices());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les factures."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload("initial"); }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return invoices.filter((invoice) => (filter === "all" || invoice.status === filter)
      && `${invoice.invoice_number} ${invoice.client_snapshot.business_name}`.toLocaleLowerCase("fr").includes(term));
  }, [invoices, search, filter]);
  const outstanding = invoices.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum + Number(invoice.total_ttc), 0);
  const opened = invoices.find((invoice) => invoice.id === openId) ?? null;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`À ENCAISSER : ${formatPrice(outstanding)}`} title="Factures" right={<Button label="+ FACTURER" onPress={() => setCreating(true)} />} />
    <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client ou un numéro" placeholderTextColor={colors.muted} style={ui.input} />
    </View>
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {statusFilters.map((item) => <Chip key={item.key} label={item.label} selected={filter === item.key} onPress={() => setFilter(item.key)} />)}
      </ScrollView>
    </View>
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(invoice) => invoice.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune facture" body="Touchez « + FACTURER » pour regrouper des bons de livraison sur une facture." />}
      renderItem={({ item }) => <Pressable style={ui.card} onPress={() => setOpenId(item.id)}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{item.invoice_number}</Text>
          <InvoiceBadge status={item.status} />
        </View>
        <Text style={ui.body}>{item.client_snapshot.business_name}</Text>
        <View style={ui.row}>
          <Text style={ui.small}>{formatDay(item.issued_at, { day: "numeric", month: "short", year: "numeric" })} · {item.orders.length} bon(s) de livraison</Text>
          <Text style={ui.amount}>{formatPrice(item.total_ttc)}</Text>
        </View>
      </Pressable>}
    />}

    <InvoiceDetail invoice={opened} onClose={() => setOpenId(null)} onChanged={() => void reload("silent")} />
    <NewInvoiceModal visible={creating} onClose={() => setCreating(false)} onCreated={(id) => { void reload("silent").then(() => setOpenId(id)); }} />
  </View>;
}

function InvoiceDetail({ invoice, onClose, onChanged }: { invoice: InvoiceWithOrders | null; onClose: () => void; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null);

  async function run(key: string, task: () => Promise<void>) {
    setBusy(key);
    try {
      await task();
    } catch (cause) {
      notify("Facture", errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusy(null);
    }
  }

  function changeStatus(status: InvoiceWithOrders["status"]) {
    if (!invoice) return;
    void run(status, async () => {
      await setInvoiceStatus(invoice.id, status);
      onChanged();
    });
  }

  function confirmCancel() {
    if (!invoice) return;
    notify("Annuler la facture", `Annuler ${invoice.invoice_number} ? Ses bons de livraison pourront être facturés à nouveau.`, [
      { text: "Retour", style: "cancel" },
      { text: "Annuler la facture", style: "destructive", onPress: () => changeStatus("cancelled") },
    ]);
  }

  return <Modal visible={invoice !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      {invoice ? <>
        <ScreenHeader eyebrow={invoice.client_snapshot.business_name.toLocaleUpperCase("fr")} title={invoice.invoice_number} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content}>
          <View style={ui.card}>
            <View style={ui.row}><Text style={ui.body}>Émise le {formatDay(invoice.issued_at, { day: "numeric", month: "long", year: "numeric" })}</Text><InvoiceBadge status={invoice.status} /></View>
            {invoice.paid_at ? <Text style={ui.small}>Payée le {formatDay(invoice.paid_at, { day: "numeric", month: "long", year: "numeric" })}</Text> : null}
            <View style={ui.divider}>
              {[...invoice.orders].sort((a, b) => a.order_number - b.order_number).map((order) => <View key={order.id} style={[ui.row, { paddingVertical: 3 }]}>
                <Text style={[ui.body, { flex: 1 }]}>{deliveryNoteNumber(order)} · {order.address_snapshot?.point_label ?? ""}</Text>
                <StatusBadge status={order.status} />
              </View>)}
            </View>
            <View style={ui.divider}>
              <View style={ui.row}><Text style={ui.body}>Total HT</Text><Text style={ui.body}>{formatPrice(invoice.total_ht)}</Text></View>
              {invoice.vat_breakdown.map((item) => <View key={String(item.rate)} style={ui.row}><Text style={ui.small}>TVA {Number(item.rate)} %</Text><Text style={ui.small}>{formatPrice(item.vat)}</Text></View>)}
              <View style={ui.row}><Text style={ui.small}>Timbre fiscal</Text><Text style={ui.small}>{formatPrice(invoice.stamp_duty)}</Text></View>
              <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Net à payer TTC</Text><Text style={ui.amount}>{formatPrice(invoice.total_ttc)}</Text></View>
            </View>
          </View>
          <Button label="FACTURE PDF" onPress={() => void run("pdf", () => shareInvoice(invoice))} busy={busy === "pdf"} style={{ marginTop: 14 }} />
          {invoice.status === "issued" ? <Button label="MARQUER PAYÉE" variant="secondary" onPress={() => changeStatus("paid")} busy={busy === "paid"} style={{ marginTop: 10 }} /> : null}
          {invoice.status === "paid" ? <Button label="REMETTRE À ENCAISSER" variant="secondary" onPress={() => changeStatus("issued")} busy={busy === "issued"} style={{ marginTop: 10 }} /> : null}
          {invoice.status !== "cancelled" ? <Button label="ANNULER LA FACTURE" variant="danger" onPress={confirmCancel} busy={busy === "cancelled"} style={{ marginTop: 10 }} /> : null}
        </ScrollView>
      </> : null}
    </SafeAreaView>
  </Modal>;
}

function NewInvoiceModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: (invoiceId: string) => void }) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [search, setSearch] = useState("");
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setClient(null);
    setSearch("");
    setError("");
    setLoading(true);
    void fetchClients()
      .then(setClients)
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger les clients.")))
      .finally(() => setLoading(false));
  }, [visible]);

  async function pick(record: ClientRecord) {
    setClient(record);
    setOrders([]);
    setSelected([]);
    setError("");
    setLoading(true);
    try {
      const next = await fetchUninvoicedOrders(record.id);
      setOrders(next);
      // Delivered notes are the usual ones to invoice; others can be added by hand.
      setSelected(next.filter((order) => order.status === "delivered").map((order) => order.id));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les bons de livraison."));
    } finally {
      setLoading(false);
    }
  }

  async function create() {
    if (!client || selected.length === 0) return;
    setBusy(true);
    setError("");
    try {
      const invoice = await createInvoice(client.id, selected);
      onClose();
      onCreated(invoice.id);
    } catch (cause) {
      setError(errorMessage(cause, "La facture n’a pas pu être créée."));
    } finally {
      setBusy(false);
    }
  }

  const term = search.trim().toLocaleLowerCase("fr");
  const visibleClients = clients.filter((record) => record.business_name.toLocaleLowerCase("fr").includes(term));
  const totals = invoiceTotals(orders.filter((order) => selected.includes(order.id)));
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader
        eyebrow={client ? "BONS À FACTURER" : "NOUVELLE FACTURE"}
        title={client ? client.business_name : "Choisir le client"}
        right={<CloseButton onPress={onClose} />}
      />
      {!client ? <>
        <View style={{ paddingHorizontal: 18, paddingTop: 12 }}>
          <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={ui.input} />
        </View>
        {loading ? <Loading /> : <FlatList
          data={visibleClients}
          keyExtractor={(record) => record.id}
          contentContainerStyle={ui.content}
          ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          renderItem={({ item }) => <Pressable style={ui.card} onPress={() => void pick(item)}>
            <Text style={ui.strong}>{item.business_name}</Text>
            <Text style={ui.small}>{formatClientNumber(item.client_number)} · facturation {item.invoice_mode === "auto" ? "automatique" : "manuelle"}</Text>
          </Pressable>}
        />}
      </> : loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content}>
        <Pressable onPress={() => setClient(null)} style={{ paddingTop: 12 }}><Text style={[ui.small, { color: colors.green, fontWeight: "800" }]}>‹ CHANGER DE CLIENT</Text></Pressable>
        {orders.length === 0 ? <EmptyState title="Rien à facturer" body="Tous les bons acceptés de ce client sont déjà facturés." /> : <>
          <Text style={[ui.subtitle, { marginTop: 8 }]}>Cochez les bons de livraison à regrouper sur la facture.</Text>
          {orders.map((order) => {
            const checked = selected.includes(order.id);
            return <Pressable key={order.id} onPress={() => toggle(order.id)} style={[ui.card, checked && styles.selectedCard]}>
              <View style={ui.row}>
                <View style={[styles.checkbox, checked && styles.checkboxChecked]}>{checked ? <Text style={styles.checkmark}>✓</Text> : null}</View>
                <Text style={[ui.strong, { flex: 1 }]}>{deliveryNoteNumber(order)}</Text>
                <StatusBadge status={order.status} />
              </View>
              <View style={[ui.row, { marginLeft: 34 }]}>
                <Text style={ui.small}>{formatDay(order.created_at)}{order.address_snapshot?.point_label ? ` · ${order.address_snapshot.point_label}` : ""} · {order.order_items.length} produit(s)</Text>
                <Text style={ui.body}>{formatPrice(order.total)} HT</Text>
              </View>
            </Pressable>;
          })}
          <View style={ui.card}>
            <View style={ui.row}><Text style={ui.body}>Total HT</Text><Text style={ui.body}>{formatPrice(totals.ht)}</Text></View>
            {totals.breakdown.map((item) => <View key={item.rate} style={ui.row}><Text style={ui.small}>TVA {item.rate} %</Text><Text style={ui.small}>{formatPrice(item.vat)}</Text></View>)}
            <View style={ui.row}><Text style={ui.small}>Timbre fiscal</Text><Text style={ui.small}>{formatPrice(totals.stamp)}</Text></View>
            <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Net à payer TTC</Text><Text style={ui.amount}>{formatPrice(totals.ttc)}</Text></View>
          </View>
        </>}
        {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        {orders.length ? <Button label={`CRÉER LA FACTURE (${selected.length} BON${selected.length > 1 ? "S" : ""})`} onPress={() => void create()} busy={busy} disabled={selected.length === 0} style={{ marginTop: 16 }} /> : null}
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  filters: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  selectedCard: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.green, borderColor: colors.green },
  checkmark: { color: colors.white, fontWeight: "800" },
});
