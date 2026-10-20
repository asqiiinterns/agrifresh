import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { fetchClients, type ClientRecord } from "../data/clients";
import { fetchInvoices, type InvoiceWithOrders } from "../data/invoices";
import { deliveryNoteNumber, fetchClientOrders, type Order } from "../data/orders";
import {
  creditLabel, creditReturn, creditStatusStyle, createCreditNote, fetchCreditNotes, fetchReturns, requestReturn, returnReasonLabel, returnReasons,
  returnStatusStyle, shareCreditNote, staffCreateReturn, updateCreditNote, updateReturn,
  type CreditLineInput, type CreditNote, type ProductReturn, type ReturnReason,
} from "../data/returns";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader, Sheets, formatDateTime, formatPrice, formatQuantity } from "../ui/components";
import { DocumentViewerHost } from "../ui/DocumentViewer";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

function Badge({ style }: { style: { label: string; color: string; background: string } }) {
  return <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>;
}

// Team: returns (request → acceptance → goods received → credit note) and credit notes.
export function ReturnsScreen({ initialSheet, initialOrderId }: { initialSheet?: string; initialOrderId?: string }) {
  // Opened from an alert: the return(s) of that order only, until "Voir tous".
  const [focusOrder, setFocusOrder] = useState<string | null>(initialOrderId ?? null);
  const [sheet, setSheet] = useState<"returns" | "credits">(initialSheet === "credits" ? "credits" : "returns");
  const [returns, setReturns] = useState<ProductReturn[]>([]);
  const [credits, setCredits] = useState<CreditNote[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState<"return" | "credit" | null>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      const [nextReturns, nextCredits] = await Promise.all([fetchReturns(), fetchCreditNotes()]);
      setReturns(nextReturns);
      setCredits(nextCredits);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les retours. La migration 20261030 est-elle exécutée ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime.channel("returns-screen")
      .on("postgres_changes", { event: "*", schema: "public", table: "returns" }, () => { void reload(); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  const pending = returns.filter((item) => ["requested", "approved", "received"].includes(item.status)).length;
  const openCredits = credits.filter((item) => item.status === "draft" || item.status === "issued").length;
  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />;

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow={`${pending} RETOUR(S) À TRAITER · ${openCredits} AVOIR(S) OUVERT(S)`}
      title="Retours et avoirs"
      right={<Button label={sheet === "returns" ? "+ RETOUR" : "+ AVOIR"} onPress={() => setCreating(sheet === "returns" ? "return" : "credit")} />}
    />
    <Sheets items={[{ key: "returns", label: "Retours", count: pending || undefined }, { key: "credits", label: "Avoirs", count: openCredits || undefined }]} value={sheet} onChange={setSheet} />
    {error ? <Text style={[ui.error, { paddingHorizontal: 14, marginTop: 8 }]}>{error}</Text> : null}
    {loading ? <Loading /> : sheet === "returns"
      ? <ReturnsList returns={focusOrder ? returns.filter((item) => item.order_id === focusOrder) : returns} focused={!!focusOrder} onShowAll={() => setFocusOrder(null)} refreshControl={refresh} onChanged={() => void reload()} />
      : <CreditsList credits={credits} refreshControl={refresh} onChanged={() => void reload()} manage />}
    <ReturnFormModal mode="staff" visible={creating === "return"} onClose={() => setCreating(null)} onSaved={() => { setCreating(null); void reload(); }} />
    <CreditFormModal visible={creating === "credit"} onClose={() => setCreating(null)} onSaved={() => { setCreating(null); setSheet("credits"); void reload(); }} />
  </View>;
}

function ReturnsList({ returns, refreshControl, onChanged, focused, onShowAll }: { returns: ProductReturn[]; refreshControl: React.ReactElement<React.ComponentProps<typeof RefreshControl>>; onChanged: () => void; focused?: boolean; onShowAll?: () => void }) {
  const [state, setState] = useState(focused ? "all" : "todo");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<DateFilterValue>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [restock, setRestock] = useState<Record<string, boolean>>({});
  const term = search.trim().toLocaleLowerCase("fr");
  const visible = returns.filter((item) => (state === "all" || (state === "todo" ? ["requested", "approved", "received"].includes(item.status) : item.status === state))
    && matchesDate(item.created_at, period)
    && `${item.return_number ?? ""} ${item.clients?.business_name ?? ""} ${item.return_items.map((line) => line.product_name).join(" ")}`.toLocaleLowerCase("fr").includes(term));
  const filters: Filter[] = [
    { kind: "choice", title: "Étape", options: [{ key: "todo", label: "À traiter" }, { key: "all", label: "Tous" }, ...Object.entries(returnStatusStyle).map(([key, style]) => ({ key, label: style.label }))], value: state, defaultValue: "todo", onChange: setState },
    { kind: "date", title: "Demandé le", presets: [presets.today, presets.last7, presets.last30, presets.thisMonth], value: period, onChange: setPeriod },
  ];

  async function run(item: ProductReturn, task: () => Promise<unknown>, done?: string) {
    setBusyId(item.id);
    try {
      await task();
      if (done) notify("Retours", done);
      onChanged();
    } catch (cause) {
      notify("Retours", errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusyId(null);
    }
  }

  return <View style={{ flex: 1 }}>
    {focused ? <View style={[ui.row, styles.focusBar]}>
      <Text style={[ui.small, { flex: 1, color: colors.text }]}>Retour ouvert depuis une alerte.</Text>
      <Button label="VOIR TOUS" variant="secondary" onPress={() => { setState("todo"); onShowAll?.(); }} />
    </View> : <FilterBar search={search} onSearch={setSearch} placeholder="N°, client ou produit" filters={filters} />}
    <FlatList
      data={visible}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={refreshControl}
      ListEmptyComponent={<EmptyState title="Aucun retour" body="Les demandes de retour des clients et les retours saisis apparaîtront ici." />}
      renderItem={({ item }) => {
        const busy = busyId === item.id;
        const total = item.return_items.reduce((sum, line) => sum + Number(line.quantity) * Number(line.unit_price), 0);
        return <View style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.clients?.business_name ?? "Client"}</Text>
            <Badge style={returnStatusStyle[item.status]} />
          </View>
          <Text style={ui.small}>{item.return_number} · {item.orders ? `${deliveryNoteNumber(item.orders)} (cde #${item.orders.order_number})` : "sans commande"} · {formatDateTime(item.created_at)}</Text>
          <Text style={[ui.small, { color: colors.text }]}>Motif : {returnReasonLabel(item.reason)}{item.description ? ` — ${item.description}` : ""}</Text>
          <View style={ui.divider}>
            {item.return_items.map((line) => <View key={line.id} style={ui.row}>
              <Text style={[ui.body, { flex: 1 }]}><Text style={{ fontWeight: "800" }}>{formatQuantity(line.quantity)} {line.unit}</Text> · {line.product_name}</Text>
              <Text style={ui.small}>{formatPrice(Number(line.quantity) * Number(line.unit_price))}</Text>
            </View>)}
            <Text style={[ui.small, { textAlign: "right" }]}>Valeur HT : {formatPrice(total)}</Text>
          </View>
          {item.staff_note ? <Text style={[ui.small, { color: colors.amber }]}>Note : {item.staff_note}</Text> : null}
          {item.status === "received" ? <Text style={ui.small}>Reçu le {item.received_at ? formatDateTime(item.received_at) : "—"}{item.restocked ? " · remis en stock" : " · non remis en stock"}</Text> : null}
          {item.credit_notes.map((credit) => <Text key={credit.id} style={[ui.small, { color: colors.primary, fontWeight: "700" }]}>Avoir {creditLabel(credit)} · {creditStatusStyle[credit.status].label}</Text>)}

          {item.status === "requested" || item.status === "approved" ? <TextInput value={notes[item.id] ?? ""} onChangeText={(text) => setNotes({ ...notes, [item.id]: text })} placeholder="Note au client (facultatif)" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} /> : null}
          {item.status === "approved" ? <View style={[ui.row, { marginTop: 8 }]}>
            <Text style={[ui.body, { flex: 1 }]}>Remettre en stock à la réception</Text>
            <Switch value={restock[item.id] ?? true} onValueChange={(value) => setRestock({ ...restock, [item.id]: value })} trackColor={{ true: colors.primary, false: colors.line }} />
          </View> : null}
          <View style={[ui.wrapRow, { marginTop: 8 }]}>
            {item.status === "requested" ? <>
              <Button label="ACCEPTER" onPress={() => run(item, () => updateReturn(item.id, "approve", notes[item.id]))} busy={busy} style={{ flexGrow: 1 }} />
              <Button label="REFUSER" variant="danger" onPress={() => run(item, () => updateReturn(item.id, "refuse", notes[item.id]))} disabled={busy} />
            </> : null}
            {item.status === "approved" ? <>
              <Button label="MARCHANDISE REÇUE" onPress={() => run(item, () => updateReturn(item.id, "receive", notes[item.id], restock[item.id] ?? true))} busy={busy} style={{ flexGrow: 1 }} />
              <Button label="AVOIR SANS RETOUR" variant="secondary" onPress={() => run(item, () => creditReturn(item.id, false), "Avoir créé en brouillon (onglet Avoirs).")} disabled={busy} />
              <Button label="REFUSER" variant="danger" onPress={() => run(item, () => updateReturn(item.id, "refuse", notes[item.id]))} disabled={busy} />
            </> : null}
            {item.status === "received" ? <>
              <Button label="ÉMETTRE L’AVOIR" onPress={() => run(item, () => creditReturn(item.id, true), "Avoir émis et envoyé au client.")} busy={busy} style={{ flexGrow: 1 }} />
              <Button label="AVOIR EN BROUILLON" variant="secondary" onPress={() => run(item, () => creditReturn(item.id, false), "Avoir créé en brouillon (onglet Avoirs).")} disabled={busy} />
            </> : null}
          </View>
        </View>;
      }}
    />
  </View>;
}

export function CreditsList({ credits, refreshControl, onChanged, manage }: { credits: CreditNote[]; refreshControl: React.ReactElement<React.ComponentProps<typeof RefreshControl>>; onChanged: () => void; manage?: boolean }) {
  const [state, setState] = useState("all");
  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState<DateFilterValue>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const term = search.trim().toLocaleLowerCase("fr");
  const visible = credits.filter((item) => (state === "all" || item.status === state)
    && matchesDate(item.issued_at ?? item.created_at, period)
    && `${item.credit_number ?? ""} ${item.clients?.business_name ?? ""} ${item.reason ?? ""}`.toLocaleLowerCase("fr").includes(term));
  const filters: Filter[] = [
    { kind: "choice", title: "Statut", options: [{ key: "all", label: "Tous" }, ...Object.entries(creditStatusStyle).filter(([key]) => manage || key !== "draft").map(([key, style]) => ({ key, label: style.label }))], value: state, defaultValue: "all", onChange: setState },
    { kind: "date", title: "Émis le", presets: [presets.last7, presets.last30, presets.thisMonth, presets.lastMonth], value: period, onChange: setPeriod },
  ];

  async function run(item: CreditNote, action: Parameters<typeof updateCreditNote>[1]) {
    setBusyId(item.id);
    try {
      await updateCreditNote(item.id, action);
      onChanged();
    } catch (cause) {
      notify("Avoirs", errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusyId(null);
    }
  }

  function confirm(item: CreditNote, action: "cancelled" | "delete") {
    notify(action === "delete" ? "Supprimer le brouillon" : "Annuler l’avoir", `${creditLabel(item)} · ${item.clients?.business_name ?? ""}`, [
      { text: "Retour", style: "cancel" },
      { text: action === "delete" ? "Supprimer" : "Annuler l’avoir", style: "destructive", onPress: () => void run(item, action) },
    ]);
  }

  return <View style={{ flex: 1 }}>
    <FilterBar search={search} onSearch={setSearch} placeholder="N°, client ou motif" filters={filters} />
    <FlatList
      data={visible}
      keyExtractor={(item) => item.id}
      contentContainerStyle={ui.content}
      refreshControl={refreshControl}
      ListEmptyComponent={<EmptyState title="Aucun avoir" body={manage ? "Créez un avoir depuis un retour reçu, ou un avoir libre (geste commercial)." : "Vos avoirs apparaîtront ici."} />}
      renderItem={({ item }) => {
        const busy = busyId === item.id;
        return <View style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{manage ? item.clients?.business_name ?? "Client" : `Avoir ${creditLabel(item)}`}</Text>
            <Badge style={creditStatusStyle[item.status]} />
          </View>
          <Text style={ui.small}>{manage ? `${creditLabel(item)} · ` : ""}{formatDateTime(item.issued_at ?? item.created_at)}{item.client_invoices?.invoice_number ? ` · facture ${item.client_invoices.invoice_number}` : ""}</Text>
          {item.reason ? <Text style={[ui.small, { color: colors.text }]}>{item.reason}</Text> : null}
          <View style={[ui.row, ui.divider]}>
            <Text style={ui.small}>{item.credit_note_items.length} ligne(s) · HT {formatPrice(item.total_ht)}</Text>
            <Text style={ui.amount}>{formatPrice(item.total_ttc)}</Text>
          </View>
          <View style={[ui.wrapRow, { marginTop: 8 }]}>
            <Button label="PDF" variant="secondary" onPress={() => shareCreditNote(item).catch((cause: unknown) => notify("Avoir", errorMessage(cause, "Impossible de générer le PDF.")))} />
            {manage && item.status === "draft" ? <>
              <Button label="ÉMETTRE" onPress={() => run(item, "issue")} busy={busy} style={{ flexGrow: 1 }} />
              <Button label="SUPPRIMER" variant="danger" onPress={() => confirm(item, "delete")} disabled={busy} />
            </> : null}
            {manage && item.status === "issued" ? <>
              <Button label="REMBOURSÉ" onPress={() => run(item, "refunded")} busy={busy} />
              <Button label="DÉDUIT D’UNE FACTURE" variant="secondary" onPress={() => run(item, "deducted")} disabled={busy} />
            </> : null}
            {manage && ["issued", "refunded", "deducted"].includes(item.status) ? <Button label="ANNULER" variant="danger" onPress={() => confirm(item, "cancelled")} disabled={busy} /> : null}
          </View>
        </View>;
      }}
    />
  </View>;
}

// Return of goods from a delivered order: the client asks, the team enters it directly.
export function ReturnFormModal({ mode, visible, order, onClose, onSaved }: { mode: "client" | "staff"; visible: boolean; order?: Order | null; onClose: () => void; onSaved: () => void }) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<Order | null>(null);
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<ReturnReason>("quality");
  const [description, setDescription] = useState("");
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setClient(null);
    setSelected(order ?? null);
    setQuantities({});
    setReason("quality");
    setDescription("");
    setSearch("");
    setError("");
    if (mode === "staff" && !order) void fetchClients().then(setClients).catch(() => setClients([]));
  }, [visible]);

  useEffect(() => {
    if (!client) return;
    void fetchClientOrders(client.id).then((list) => setOrders(list.filter((item) => item.status === "delivered"))).catch(() => setOrders([]));
  }, [client?.id]);

  const lines = useMemo(() => {
    const map = new Map<string, { product_id: string; name: string; unit: string; quantity: number }>();
    for (const line of selected?.order_items ?? []) {
      if (!line.product_id) continue;
      const entry = map.get(line.product_id) ?? { product_id: line.product_id, name: line.product_name_snapshot, unit: line.unit_snapshot, quantity: 0 };
      entry.quantity += Number(line.quantity);
      map.set(line.product_id, entry);
    }
    return [...map.values()];
  }, [selected?.id]);

  async function save() {
    if (!selected) return;
    const items = lines.map((line) => ({ product_id: line.product_id, quantity: Number((quantities[line.product_id] ?? "").replace(",", ".")) })).filter((item) => item.quantity > 0);
    if (!items.length) {
      setError("Indiquez la quantité à retourner pour au moins un produit.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const number = mode === "client" ? await requestReturn(selected.id, items, reason, description) : await staffCreateReturn(selected.id, items, reason, description);
      notify(mode === "client" ? "Demande envoyée" : "Retour créé", mode === "client" ? `Votre demande ${number} est transmise à votre fournisseur. Vous serez averti de la réponse.` : `Retour ${number} accepté : marquez la marchandise reçue à son arrivée.`);
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "Le retour n’a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  const term = search.trim().toLocaleLowerCase("fr");
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={mode === "client" ? "DEMANDE DE RETOUR" : "NOUVEAU RETOUR"} title={selected ? `Commande #${selected.order_number}` : client ? client.business_name : "Choisir le client"} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {!selected && !client ? <>
          <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} />
          {clients.filter((item) => item.business_name.toLocaleLowerCase("fr").includes(term)).map((item) => <Pressable key={item.id} onPress={() => setClient(item)} style={[ui.card, ui.row]}>
            <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>)}
        </> : !selected ? <>
          <Pressable onPress={() => setClient(null)} style={{ marginTop: 8 }}><Text style={styles.link}>‹ Changer de client</Text></Pressable>
          {orders.length === 0 ? <EmptyState title="Aucune commande livrée" body="Un retour concerne une commande livrée." /> : orders.map((item) => <Pressable key={item.id} onPress={() => setSelected(item)} style={[ui.card, ui.row]}>
            <View style={{ flex: 1 }}>
              <Text style={ui.strong}>{deliveryNoteNumber(item)} · cde #{item.order_number}</Text>
              <Text style={ui.small}>Livrée le {item.delivered_at ? formatDateTime(item.delivered_at) : "—"} · {item.order_items.length} produit(s)</Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>)}
        </> : <>
          {mode === "staff" && !order ? <Pressable onPress={() => setSelected(null)} style={{ marginTop: 8 }}><Text style={styles.link}>‹ Changer de commande</Text></Pressable> : null}
          <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Quantités à retourner</Text>
          {lines.map((line) => <View key={line.product_id} style={[ui.card, ui.row]}>
            <View style={{ flex: 1 }}>
              <Text style={ui.strong}>{line.name}</Text>
              <Text style={ui.small}>Livré : {formatQuantity(line.quantity)} {line.unit}</Text>
            </View>
            <TextInput value={quantities[line.product_id] ?? ""} onChangeText={(text) => setQuantities({ ...quantities, [line.product_id]: text })} placeholder="0" placeholderTextColor={colors.muted} keyboardType="decimal-pad" style={[ui.input, { width: 80, textAlign: "right" }]} />
            <Text style={ui.small}>{line.unit}</Text>
          </View>)}
          <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Motif</Text>
          <View style={[ui.wrapRow, { marginTop: 6 }]}>
            {returnReasons.map((item) => <Chip key={item.key} label={item.label} selected={reason === item.key} onPress={() => setReason(item.key)} />)}
          </View>
          <Field label="Précisions (facultatif)" value={description} onChangeText={setDescription} multiline />
          {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
          <Button label={mode === "client" ? "ENVOYER LA DEMANDE" : "CRÉER LE RETOUR"} onPress={() => save()} busy={busy} style={{ marginTop: 14 }} />
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const vatRates = [0, 7, 13, 19];
const emptyLine = (): CreditLineInput & { key: number } => ({ key: Math.random(), label: "", quantity: 1, unit: "", unit_price: 0, vat_rate: 19 });

// Free credit note: commercial gesture, price correction… lines entered by hand.
function CreditFormModal({ visible, onClose, onSaved }: { visible: boolean; onClose: () => void; onSaved: () => void }) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [invoices, setInvoices] = useState<InvoiceWithOrders[]>([]);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [lines, setLines] = useState([emptyLine()]);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setClient(null);
    setInvoiceId(null);
    setReason("");
    setLines([emptyLine()]);
    setSearch("");
    setError("");
    void fetchClients().then(setClients).catch(() => setClients([]));
    void fetchInvoices().then(setInvoices).catch(() => setInvoices([]));
  }, [visible]);

  const total = lines.reduce((sum, line) => sum + line.quantity * line.unit_price * (1 + line.vat_rate / 100), 0);
  const setLine = (key: number, patch: Partial<CreditLineInput>) => setLines((current) => current.map((line) => line.key === key ? { ...line, ...patch } : line));
  const number = (text: string) => Number(text.replace(",", ".")) || 0;

  async function save(issue: boolean) {
    if (!client) return;
    const clean = lines.filter((line) => line.label.trim()).map(({ key: _key, ...line }) => line);
    if (!clean.length) {
      setError("Ajoutez au moins une ligne avec un libellé.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await createCreditNote(client.id, invoiceId, reason, clean, issue);
      notify("Avoir", issue ? `Avoir ${result.credit_number} émis et envoyé au client.` : "Avoir enregistré en brouillon.");
      onSaved();
    } catch (cause) {
      setError(errorMessage(cause, "L’avoir n’a pas pu être enregistré."));
    } finally {
      setBusy(false);
    }
  }

  const term = search.trim().toLocaleLowerCase("fr");
  const clientInvoices = invoices.filter((invoice) => invoice.client_id === client?.id && invoice.status !== "draft" && invoice.status !== "cancelled");
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <DocumentViewerHost />
      <ScreenHeader eyebrow="AVOIR LIBRE" title={client ? client.business_name : "Choisir le client"} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {!client ? <>
          <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher un client" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} />
          {clients.filter((item) => item.business_name.toLocaleLowerCase("fr").includes(term)).map((item) => <Pressable key={item.id} onPress={() => setClient(item)} style={[ui.card, ui.row]}>
            <Text style={[ui.strong, { flex: 1 }]}>{item.business_name}</Text>
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </Pressable>)}
        </> : <>
          <Pressable onPress={() => setClient(null)} style={{ marginTop: 8 }}><Text style={styles.link}>‹ Changer de client</Text></Pressable>
          {clientInvoices.length ? <>
            <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Sur la facture (facultatif)</Text>
            <View style={[ui.wrapRow, { marginTop: 6 }]}>
              <Chip label="Aucune" selected={invoiceId === null} onPress={() => setInvoiceId(null)} />
              {clientInvoices.slice(0, 12).map((invoice) => <Chip key={invoice.id} label={invoice.invoice_number ?? ""} selected={invoiceId === invoice.id} onPress={() => setInvoiceId(invoice.id)} />)}
            </View>
          </> : null}
          <Field label="Motif" value={reason} onChangeText={setReason} placeholder="Ex. geste commercial, erreur de prix" />
          <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Lignes</Text>
          {lines.map((line) => <View key={line.key} style={ui.card}>
            <TextInput value={line.label} onChangeText={(text) => setLine(line.key, { label: text })} placeholder="Libellé" placeholderTextColor={colors.muted} style={ui.input} />
            <View style={[ui.row, { marginTop: 6 }]}>
              <TextInput defaultValue={String(line.quantity)} onChangeText={(text) => setLine(line.key, { quantity: number(text) })} placeholder="Qté" keyboardType="decimal-pad" style={[ui.input, { flex: 1 }]} />
              <TextInput value={line.unit} onChangeText={(text) => setLine(line.key, { unit: text })} placeholder="Unité" placeholderTextColor={colors.muted} style={[ui.input, { flex: 1 }]} />
              <TextInput defaultValue={line.unit_price ? String(line.unit_price) : ""} onChangeText={(text) => setLine(line.key, { unit_price: number(text) })} placeholder="PU HT" placeholderTextColor={colors.muted} keyboardType="decimal-pad" style={[ui.input, { flex: 1 }]} />
            </View>
            <View style={[ui.row, { marginTop: 6 }]}>
              <View style={[ui.wrapRow, { flex: 1 }]}>
                {vatRates.map((rate) => <Chip key={rate} label={`TVA ${rate} %`} selected={line.vat_rate === rate} onPress={() => setLine(line.key, { vat_rate: rate })} />)}
              </View>
              {lines.length > 1 ? <Pressable onPress={() => setLines(lines.filter((item) => item.key !== line.key))} hitSlop={8}><Ionicons name="trash-outline" size={18} color={colors.danger} /></Pressable> : null}
            </View>
          </View>)}
          <Button label="+ AJOUTER UNE LIGNE" variant="secondary" onPress={() => setLines([...lines, emptyLine()])} style={{ marginTop: 8 }} />
          <Text style={[ui.amount, { textAlign: "right", marginTop: 10 }]}>Total TTC : {formatPrice(total)}</Text>
          {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
          <View style={[ui.wrapRow, { marginTop: 12 }]}>
            <Button label="ÉMETTRE L’AVOIR" onPress={() => save(true)} busy={busy} style={{ flexGrow: 1 }} />
            <Button label="BROUILLON" variant="secondary" onPress={() => save(false)} disabled={busy} />
          </View>
        </>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

// Client side: its returns, read-only, with their progress.
export function ClientReturnsList({ refreshControl, returns }: { returns: ProductReturn[]; refreshControl: React.ReactElement<React.ComponentProps<typeof RefreshControl>> }) {
  return <FlatList
    data={returns}
    keyExtractor={(item) => item.id}
    contentContainerStyle={ui.content}
    refreshControl={refreshControl}
    ListEmptyComponent={<EmptyState title="Aucun retour" body="Pour retourner un produit, ouvrez la commande livrée dans Mes commandes et touchez « Demander un retour »." />}
    renderItem={({ item }) => <View style={ui.card}>
      <View style={ui.row}>
        <Text style={[ui.strong, { flex: 1 }]}>Retour {item.return_number}</Text>
        <Badge style={returnStatusStyle[item.status]} />
      </View>
      <Text style={ui.small}>{item.orders ? `Commande #${item.orders.order_number} · ` : ""}{formatDateTime(item.created_at)} · {returnReasonLabel(item.reason)}</Text>
      {item.return_items.map((line) => <Text key={line.id} style={ui.body}>{formatQuantity(line.quantity)} {line.unit} · {line.product_name}</Text>)}
      {item.staff_note ? <Text style={[ui.small, { color: colors.text, marginTop: 4 }]}>Fournisseur : {item.staff_note}</Text> : null}
      {item.credit_notes.filter((credit) => credit.status !== "draft").map((credit) => <Text key={credit.id} style={[ui.small, { color: colors.primary, fontWeight: "700" }]}>Avoir {creditLabel(credit)}</Text>)}
    </View>}
  />;
}

const styles = StyleSheet.create({
  focusBar: { marginHorizontal: 14, marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: colors.primarySoft, borderWidth: 1, borderColor: colors.primary },
  link: { color: colors.primary, fontSize: 12, fontWeight: "800" },
});
