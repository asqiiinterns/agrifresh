import { useEffect, useMemo, useState } from "react";
import { FlatList, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { formatClientNumber } from "../data/account";
import { fetchClients, type ClientRecord } from "../data/clients";
import { addPayment, balanceOf, createInvoice, deleteInvoiceDraft, deletePayment, fetchInvoices, fetchUninvoicedOrders, invoiceLabel, invoiceTotals, isOverdue, issueInvoice, paymentMethodLabel, paymentMethods, sendReminders, setInvoiceStatus, shareInvoice, updateInvoiceDraft, type InvoiceWithOrders, type PaymentMethod } from "../data/invoices";
import { fetchCreditNotes, type CreditNote } from "../data/returns";
import { CreditsList } from "./ReturnsScreen";
import { BillingDashboard } from "./BillingDashboard";
import { deliveryNoteNumber, type Order } from "../data/orders";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader, Sheets, StatusBadge, formatDay, formatPrice, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { DocumentViewerHost } from "../ui/DocumentViewer";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";

const statusFilters = [
  { key: "all", label: "Toutes" },
  { key: "draft", label: "Brouillons" },
  { key: "issued", label: "À encaisser" },
  { key: "overdue", label: "En retard" },
  { key: "paid", label: "Payées" },
  { key: "cancelled", label: "Annulées" },
] as const;

export const invoiceStatusStyle = {
  draft: { label: "Brouillon", color: "#5f685d", background: "#ecebe5" },
  issued: { label: "À encaisser", color: colors.amber, background: "#fdf3e1" },
  paid: { label: "Payée", color: colors.green, background: "#dcebd7" },
  cancelled: { label: "Annulée", color: colors.danger, background: "#f8e5e1" },
};

export function InvoiceBadge({ status }: { status: InvoiceWithOrders["status"] }) {
  const style = invoiceStatusStyle[status];
  return <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>;
}

type Editor = { mode: "new" } | { mode: "edit"; invoice: InvoiceWithOrders };

const sorts = [
  { key: "issued_desc", label: "Émission (récentes d’abord)" },
  { key: "issued_asc", label: "Émission (anciennes d’abord)" },
  { key: "number", label: "Numéro de facture" },
  { key: "due", label: "Échéance" },
  { key: "paid", label: "Date de règlement" },
  { key: "amount", label: "Montant restant" },
] as const;

export function StaffInvoicesScreen() {
  // Facturation: invoices, credit notes and figures, as sheets.
  const [sheet, setSheet] = useState<"invoices" | "credits" | "dashboard">("invoices");
  const [invoices, setInvoices] = useState<InvoiceWithOrders[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<string>("all");
  const [issued, setIssued] = useState<DateFilterValue>(null);
  const [paidOn, setPaidOn] = useState<DateFilterValue>(null);
  const [sort, setSort] = useState<string>("issued_desc");
  const [credits, setCredits] = useState<CreditNote[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      const [nextInvoices, nextCredits] = await Promise.all([fetchInvoices(), fetchCreditNotes().catch(() => [] as CreditNote[])]);
      setInvoices(nextInvoices);
      setCredits(nextCredits);
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
    const list = invoices.filter((invoice) => (filter === "all" || (filter === "overdue" ? isOverdue(invoice) : invoice.status === filter))
      && matchesDate(invoice.issued_at, issued)
      && (!paidOn || matchesDate(invoice.paid_at, paidOn))
      && `${invoice.invoice_number ?? "brouillon"} ${invoice.client_snapshot.business_name}`.toLocaleLowerCase("fr").includes(term));
    const text = (value: string | null | undefined, missing = "9999") => value ?? missing;
    return [...list].sort((a, b) => sort === "issued_asc" ? a.issued_at.localeCompare(b.issued_at)
      : sort === "number" ? text(a.invoice_number, "~").localeCompare(text(b.invoice_number, "~"), "fr", { numeric: true })
      : sort === "due" ? text(a.due_date).localeCompare(text(b.due_date))
      : sort === "paid" ? text(b.paid_at, "").localeCompare(text(a.paid_at, ""))
      : sort === "amount" ? balanceOf(b) - balanceOf(a)
      : b.issued_at.localeCompare(a.issued_at));
  }, [invoices, search, filter, issued, paidOn, sort]);
  const listFilters: Filter[] = [
    { kind: "choice", title: "Statut", options: statusFilters.map((item) => ({ key: item.key, label: item.label, count: item.key === "all" ? invoices.length : item.key === "overdue" ? invoices.filter(isOverdue).length : invoices.filter((invoice) => invoice.status === item.key).length })), value: filter, defaultValue: "all", onChange: setFilter },
    { kind: "choice", title: "Trier par", options: sorts.map((item) => ({ key: item.key, label: item.label })), value: sort, defaultValue: "issued_desc", onChange: setSort },
    { kind: "date", title: "Émise le", presets: [presets.today, presets.yesterday, presets.last7, presets.thisMonth, presets.lastMonth], value: issued, onChange: setIssued },
    { kind: "date", title: "Réglée le", presets: [presets.today, presets.last7, presets.thisMonth, presets.lastMonth], value: paidOn, onChange: setPaidOn },
  ];
  const outstanding = invoices.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum + balanceOf(invoice), 0);
  const overdueCount = invoices.filter(isOverdue).length;
  const [reminding, setReminding] = useState(false);
  async function remindAll() {
    setReminding(true);
    try {
      const count = await sendReminders();
      notify("Relances", count ? `${count} relance(s) envoyée(s) aux clients concernés.` : "Aucune relance à envoyer : les clients en retard ont déjà été relancés récemment, ou leurs relances sont désactivées.");
      void reload("silent");
    } catch (cause) {
      notify("Relances", errorMessage(cause, "Les relances n’ont pas pu être envoyées. La migration 20261031 est-elle exécutée ?"));
    } finally {
      setReminding(false);
    }
  }
  const drafts = invoices.filter((invoice) => invoice.status === "draft").length;
  const opened = invoices.find((invoice) => invoice.id === openId) ?? null;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`À ENCAISSER : ${formatPrice(outstanding)}${drafts ? ` · ${drafts} BROUILLON(S)` : ""}`} title="Facturation" right={sheet === "invoices" ? <Button label="+ FACTURER" onPress={() => setEditor({ mode: "new" })} /> : undefined} />
    <Sheets items={[{ key: "invoices", label: "Factures", count: overdueCount || undefined }, { key: "credits", label: "Avoirs" }, { key: "dashboard", label: "Tableau de bord" }]} value={sheet} onChange={setSheet} />
    {sheet === "credits" ? <CreditsList credits={credits} manage refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />} onChanged={() => void reload("silent")} />
      : sheet === "dashboard" ? (loading ? <Loading /> : <BillingDashboard invoices={invoices} credits={credits} />)
      : <>
    <FilterBar search={search} onSearch={setSearch} placeholder="Client ou numéro de facture" filters={listFilters} />
    {overdueCount ? <View style={[ui.row, { paddingHorizontal: 14, marginTop: 6 }]}>
      <Text style={[ui.small, { flex: 1, color: colors.danger, fontWeight: "800" }]}>{overdueCount} facture(s) en retard de paiement</Text>
      <Button label="ENVOYER LES RELANCES" variant="secondary" onPress={() => void remindAll()} busy={reminding} />
    </View> : null}
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(invoice) => invoice.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucune facture" body="Touchez « + FACTURER » pour regrouper des bons de livraison sur une facture." />}
      renderItem={({ item }) => <Pressable style={ui.card} onPress={() => setOpenId(item.id)}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>{invoiceLabel(item)}</Text>
          <InvoiceBadge status={item.status} />
        </View>
        <Text style={ui.body}>{item.client_snapshot.business_name}</Text>
        <View style={ui.row}>
          <Text style={ui.small}>{formatDay(item.issued_at, { day: "numeric", month: "short", year: "numeric" })} · {item.orders.length} BL{item.due_date && item.status === "issued" ? ` · échéance ${formatDay(item.due_date, { day: "numeric", month: "short" })}` : ""}</Text>
          <Text style={ui.amount}>{formatPrice(item.total_ttc)}</Text>
        </View>
        {item.status === "issued" && Number(item.amount_paid ?? 0) > 0 ? <Text style={[ui.small, { color: colors.text }]}>Payé {formatPrice(item.amount_paid ?? 0)} · reste <Text style={{ fontWeight: "800" }}>{formatPrice(balanceOf(item))}</Text></Text> : null}
        {isOverdue(item) ? <Text style={[ui.small, { color: colors.danger, fontWeight: "800" }]}>En retard{item.reminder_count ? ` · ${item.reminder_count} relance(s)` : ""}</Text> : null}
      </Pressable>}
    />}
    </>}

    <InvoiceDetail
      invoice={opened}
      onClose={() => setOpenId(null)}
      onChanged={() => void reload("silent")}
      onEdit={(invoice) => setEditor({ mode: "edit", invoice })}
    />
    <InvoiceEditor
      editor={editor}
      onClose={() => setEditor(null)}
      onSaved={(id) => { void reload("silent").then(() => setOpenId(id)); }}
    />
  </View>;
}

function InvoiceDetail({ invoice, onClose, onChanged, onEdit }: {
  invoice: InvoiceWithOrders | null;
  onClose: () => void;
  onChanged: () => void;
  onEdit: (invoice: InvoiceWithOrders) => void;
}) {
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

  function changeStatus(status: "issued" | "paid" | "cancelled") {
    if (!invoice) return;
    void run(status, async () => {
      await setInvoiceStatus(invoice.id, status);
      onChanged();
    });
  }

  function issue() {
    if (!invoice) return;
    notify("Valider la facture", "Une fois validée, la facture reçoit son numéro définitif, devient visible par le client et ne peut plus être modifiée.", [
      { text: "Retour", style: "cancel" },
      { text: "Valider", onPress: () => void run("issue", async () => {
        const number = await issueInvoice(invoice.id);
        onChanged();
        notify("Facture validée", `Numéro attribué : ${number}.`);
      }) },
    ]);
  }

  function remove() {
    if (!invoice) return;
    notify("Supprimer le brouillon", "Ses bons de livraison redeviendront disponibles pour une autre facture.", [
      { text: "Retour", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => void run("delete", async () => {
        await deleteInvoiceDraft(invoice.id);
        onClose();
        onChanged();
      }) },
    ]);
  }

  function confirmCancel() {
    if (!invoice) return;
    notify("Annuler la facture", `Annuler ${invoiceLabel(invoice)} ? Ses bons de livraison pourront être facturés à nouveau.`, [
      { text: "Retour", style: "cancel" },
      { text: "Annuler la facture", style: "destructive", onPress: () => changeStatus("cancelled") },
    ]);
  }

  return <Modal visible={invoice !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <DocumentViewerHost />
      {invoice ? <>
        <ScreenHeader eyebrow={invoice.client_snapshot.business_name.toLocaleUpperCase("fr")} title={invoiceLabel(invoice)} right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content}>
          {invoice.status === "draft" ? <Text style={[ui.body, styles.draftBanner]}>Brouillon : modifiable, sans numéro et invisible pour le client tant qu’il n’est pas validé.</Text> : null}
          <View style={ui.card}>
            <View style={ui.row}>
              <Text style={ui.body}>{invoice.status === "draft" ? "Créé le" : "Émise le"} {formatDay(invoice.issued_at, { day: "numeric", month: "long", year: "numeric" })}</Text>
              <InvoiceBadge status={invoice.status} />
            </View>
            {invoice.paid_at ? <Text style={ui.small}>Payée le {formatDay(invoice.paid_at, { day: "numeric", month: "long", year: "numeric" })}</Text> : null}
            <View style={ui.divider}>
              {[...invoice.orders].sort((a, b) => a.order_number - b.order_number).map((order) => <View key={order.id} style={[ui.row, { paddingVertical: 3 }]}>
                <Text style={[ui.body, { flex: 1 }]}>{deliveryNoteNumber(order)} · {order.address_snapshot?.point_label ?? ""}</Text>
                <StatusBadge status={order.status} />
              </View>)}
              {invoice.orders.length === 0 ? <Text style={ui.small}>Aucun bon : modifiez le brouillon pour en ajouter.</Text> : null}
            </View>
            <View style={ui.divider}>
              <View style={ui.row}><Text style={ui.body}>Total HT</Text><Text style={ui.body}>{formatPrice(invoice.total_ht)}</Text></View>
              {invoice.vat_breakdown.map((item) => <View key={String(item.rate)} style={ui.row}><Text style={ui.small}>TVA {Number(item.rate)} %</Text><Text style={ui.small}>{formatPrice(item.vat)}</Text></View>)}
              <View style={ui.row}><Text style={ui.small}>Timbre fiscal</Text><Text style={ui.small}>{formatPrice(invoice.stamp_duty)}</Text></View>
              <View style={[ui.row, ui.divider]}><Text style={ui.strong}>Net à payer TTC</Text><Text style={ui.amount}>{formatPrice(invoice.total_ttc)}</Text></View>
            </View>
          </View>
          <Button label="VOIR LA FACTURE" onPress={() => void run("pdf", () => shareInvoice(invoice))} busy={busy === "pdf"} style={{ marginTop: 14 }} />
          {invoice.status === "draft" ? <>
            <Button label="VALIDER LA FACTURE" onPress={issue} busy={busy === "issue"} disabled={invoice.orders.length === 0} style={{ marginTop: 10 }} />
            <Button label="MODIFIER LES BONS" variant="secondary" onPress={() => onEdit(invoice)} style={{ marginTop: 10 }} />
            <Button label="SUPPRIMER LE BROUILLON" variant="danger" onPress={remove} busy={busy === "delete"} style={{ marginTop: 10 }} />
          </> : null}
          {invoice.status === "issued" || invoice.status === "paid" ? <PaymentsCard invoice={invoice} onChanged={onChanged} /> : null}
          {isOverdue(invoice) ? <Button label="RELANCER LE CLIENT" variant="secondary" onPress={() => void run("remind", async () => {
            const count = await sendReminders(invoice.client_id, true);
            notify("Relance", count ? "Rappel envoyé au client." : "Les relances sont désactivées pour ce client.");
            onChanged();
          })} busy={busy === "remind"} style={{ marginTop: 10 }} /> : null}
          {invoice.status === "issued" || invoice.status === "paid" ? <Button label="ANNULER LA FACTURE" variant="danger" onPress={confirmCancel} busy={busy === "cancelled"} style={{ marginTop: 10 }} /> : null}
        </ScrollView>
      </> : null}
    </SafeAreaView>
  </Modal>;
}

function InvoiceEditor({ editor, onClose, onSaved }: { editor: Editor | null; onClose: () => void; onSaved: (invoiceId: string) => void }) {
  const [clients, setClients] = useState<ClientRecord[]>([]);
  const [search, setSearch] = useState("");
  const [client, setClient] = useState<ClientRecord | null>(null);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"draft" | "issue" | null>(null);
  const [error, setError] = useState("");
  const draft = editor?.mode === "edit" ? editor.invoice : null;

  useEffect(() => {
    if (!editor) return;
    setClient(null);
    setSearch("");
    setError("");
    setLoading(true);
    void fetchClients()
      .then(async (records) => {
        setClients(records);
        if (draft) {
          const record = records.find((item) => item.id === draft.client_id);
          if (record) await pick(record, draft.id, draft.orders.map((order) => order.id));
        }
      })
      .catch((cause: unknown) => setError(errorMessage(cause, "Impossible de charger les clients.")))
      .finally(() => setLoading(false));
  }, [editor]);

  async function pick(record: ClientRecord, draftId?: string, preselected?: string[]) {
    setClient(record);
    setOrders([]);
    setSelected([]);
    setError("");
    setLoading(true);
    try {
      const next = await fetchUninvoicedOrders(record.id, draftId);
      setOrders(next);
      // Delivered notes are the usual ones to invoice; others can be added by hand.
      setSelected(preselected ?? next.filter((order) => order.status === "delivered").map((order) => order.id));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les bons de livraison."));
    } finally {
      setLoading(false);
    }
  }

  async function save(issue: boolean) {
    if (!client || selected.length === 0) return;
    setBusy(issue ? "issue" : "draft");
    setError("");
    try {
      let invoiceId: string;
      if (draft) {
        await updateInvoiceDraft(draft.id, selected);
        if (issue) await issueInvoice(draft.id);
        invoiceId = draft.id;
      } else {
        invoiceId = (await createInvoice(client.id, selected, !issue)).id;
      }
      onClose();
      onSaved(invoiceId);
    } catch (cause) {
      setError(errorMessage(cause, "La facture n’a pas pu être enregistrée."));
    } finally {
      setBusy(null);
    }
  }

  const term = search.trim().toLocaleLowerCase("fr");
  const visibleClients = clients.filter((record) => record.business_name.toLocaleLowerCase("fr").includes(term));
  const totals = invoiceTotals(orders.filter((order) => selected.includes(order.id)));
  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return <Modal visible={editor !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <DocumentViewerHost />
      <ScreenHeader
        eyebrow={draft ? "MODIFIER LE BROUILLON" : client ? "BONS À FACTURER" : "NOUVELLE FACTURE"}
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
        {!draft ? <Pressable onPress={() => setClient(null)} style={{ paddingTop: 12 }}><Text style={[ui.small, { color: colors.green, fontWeight: "800" }]}>‹ CHANGER DE CLIENT</Text></Pressable> : null}
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
                <Text style={[ui.small, { flex: 1 }]}>{formatDay(order.created_at)}{order.address_snapshot?.point_label ? ` · ${order.address_snapshot.point_label}` : ""} · {order.order_items.length} produit(s)</Text>
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
        {orders.length ? <>
          <Button label={draft ? "ENREGISTRER LE BROUILLON" : "ENREGISTRER EN BROUILLON"} variant="secondary" onPress={() => void save(false)} busy={busy === "draft"} disabled={selected.length === 0 || busy !== null} style={{ marginTop: 16 }} />
          <Button label={`${draft ? "ENREGISTRER ET VALIDER" : "CRÉER ET VALIDER"} (${selected.length} BON${selected.length > 1 ? "S" : ""})`} onPress={() => void save(true)} busy={busy === "issue"} disabled={selected.length === 0 || busy !== null} style={{ marginTop: 10 }} />
        </> : null}
      </ScrollView>}
    </SafeAreaView>
  </Modal>;
}

// Payments of an invoice: partial, several methods, credit notes deducted.
function PaymentsCard({ invoice, onChanged }: { invoice: InvoiceWithOrders; onChanged: () => void }) {
  const balance = balanceOf(invoice);
  const [adding, setAdding] = useState(false);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("transfer");
  const [paidOn, setPaidOn] = useState(toDayKey(new Date()));
  const [reference, setReference] = useState("");
  const [creditId, setCreditId] = useState<string | null>(null);
  const [credits, setCredits] = useState<CreditNote[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!adding) return;
    setAmount(balance.toFixed(3));
    setError("");
    void fetchCreditNotes().then((list) => setCredits(list.filter((credit) => credit.client_id === invoice.client_id && credit.status === "issued"))).catch(() => setCredits([]));
  }, [adding]);

  async function save() {
    const value = Number(amount.replace(",", "."));
    if (!value || value <= 0) {
      setError("Indiquez le montant reçu.");
      return;
    }
    if (method === "credit_note" && !creditId) {
      setError("Choisissez l’avoir à déduire.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await addPayment(invoice.id, { amount: value, method, paidOn, reference, creditNoteId: creditId });
      setAdding(false);
      setReference("");
      onChanged();
    } catch (cause) {
      setError(errorMessage(cause, "Le règlement n’a pas pu être enregistré. La migration 20261031 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }

  function remove(paymentId: string) {
    notify("Supprimer le règlement", "Le montant redeviendra à encaisser.", [
      { text: "Retour", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => void deletePayment(paymentId).then(onChanged).catch((cause: unknown) => notify("Règlement", errorMessage(cause, "Suppression impossible."))) },
    ]);
  }

  const payments = [...(invoice.invoice_payments ?? [])].sort((a, b) => a.paid_on.localeCompare(b.paid_on));
  return <View style={ui.card}>
    <View style={ui.row}>
      <Text style={ui.strong}>Règlements</Text>
      <Text style={ui.small}>Payé {formatPrice(invoice.amount_paid ?? 0)} · reste <Text style={{ fontWeight: "800", color: balance > 0 ? colors.danger : colors.green }}>{formatPrice(balance)}</Text></Text>
    </View>
    {invoice.due_date ? <Text style={ui.small}>Échéance : {formatDay(invoice.due_date, { day: "numeric", month: "long", year: "numeric" })}{invoice.reminder_count ? ` · ${invoice.reminder_count} relance(s)` : ""}</Text> : null}
    {payments.map((payment) => <View key={payment.id} style={[ui.row, ui.divider]}>
      <View style={{ flex: 1 }}>
        <Text style={ui.body}>{paymentMethodLabel(payment.method)} · {formatDay(payment.paid_on, { day: "numeric", month: "short", year: "numeric" })}</Text>
        {payment.reference ? <Text style={ui.small}>{payment.reference}</Text> : null}
      </View>
      <Text style={[ui.body, { fontWeight: "800" }]}>{formatPrice(payment.amount)}</Text>
      <Pressable onPress={() => remove(payment.id)} hitSlop={8} accessibilityLabel="Supprimer le règlement"><Text style={{ color: colors.danger, fontSize: 18 }}>×</Text></Pressable>
    </View>)}
    {balance > 0.0005 && !adding ? <Button label="+ ENREGISTRER UN RÈGLEMENT" onPress={() => setAdding(true)} style={{ marginTop: 10 }} /> : null}
    {adding ? <View style={ui.divider}>
      <Text style={ui.fieldLabel}>Mode de règlement</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        {paymentMethods.map((item) => <Chip key={item.key} label={item.label} selected={method === item.key} onPress={() => setMethod(item.key)} />)}
      </View>
      {method === "credit_note" ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
        {credits.length ? credits.map((credit) => <Chip key={credit.id} label={`${credit.credit_number} · ${formatPrice(credit.total_ttc)}`} selected={creditId === credit.id} onPress={() => { setCreditId(credit.id); setAmount(Math.min(balance, Number(credit.total_ttc)).toFixed(3)); }} />)
          : <Text style={ui.small}>Aucun avoir émis disponible pour ce client.</Text>}
      </View> : null}
      <View style={ui.row}>
        <View style={{ flex: 1 }}><Field label="Montant (TND)" value={amount} onChangeText={setAmount} keyboardType="decimal-pad" /></View>
        <View style={{ flex: 1 }}><Field label="Date (AAAA-MM-JJ)" value={paidOn} onChangeText={setPaidOn} /></View>
      </View>
      <Field label="Référence (n° de chèque, virement…)" value={reference} onChangeText={setReference} />
      <Text style={[ui.small, { marginTop: 6 }]}>Un montant inférieur au reste enregistre un règlement partiel ; complétez ensuite avec d’autres moyens de paiement.</Text>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      <View style={[ui.wrapRow, { marginTop: 10 }]}>
        <Button label="ENREGISTRER" onPress={() => void save()} busy={busy} />
        <Button label="ANNULER" variant="secondary" onPress={() => setAdding(false)} disabled={busy} />
      </View>
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  filters: { paddingHorizontal: 18, paddingVertical: 10, gap: 7 },
  selectedCard: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  checkbox: { width: 24, height: 24, borderRadius: 6, borderWidth: 2, borderColor: colors.line, alignItems: "center", justifyContent: "center" },
  checkboxChecked: { backgroundColor: colors.green, borderColor: colors.green },
  checkmark: { color: colors.white, fontWeight: "800" },
  draftBanner: { marginTop: 12, padding: 12, borderRadius: 8, backgroundColor: "#ecebe5" },
});
