import { useEffect, useMemo, useState, type ComponentProps, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "../data/account";
import { claimReasonLabel, claimStatusStyle, fetchClaims, updateClaim, type Claim, type ClaimStatus } from "../data/claims";
import { deliveryNoteNumber, formatOrigin, shareDeliveryNote } from "../data/orders";
import { fetchAllOrders, preparationTotals, staffActions, statusGroups, updateOrderStatus, type OrderStatus, type StaffAction, type StaffOrder } from "../data/staff";
import { Button, Chip, EmptyState, Loading, ScreenHeader, StatusBadge, formatDateTime, formatDay, formatPrice, formatQuantity, statusLabel, toDayKey } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { OrderTimeline } from "../ui/OrderTimeline";
import { colors, ui } from "../ui/theme";

type Section = "decide" | "progress" | "prepare" | "claims" | "done";
type DayFilter = "all" | "late" | "today" | "tomorrow" | "later" | "none";

const dayFilters: { key: DayFilter; label: string }[] = [
  { key: "all", label: "Tous les jours" },
  { key: "late", label: "En retard" },
  { key: "today", label: "Aujourd’hui" },
  { key: "tomorrow", label: "Demain" },
  { key: "later", label: "Plus tard" },
  { key: "none", label: "Sans date" },
];

function matchesDay(order: StaffOrder, filter: DayFilter) {
  if (filter === "all") return true;
  const day = order.requested_delivery_date;
  if (filter === "none") return !day;
  if (!day) return false;
  const today = new Date();
  const todayKey = toDayKey(today);
  const tomorrowKey = toDayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1));
  if (filter === "late") return day < todayKey;
  if (filter === "today") return day === todayKey;
  if (filter === "tomorrow") return day === tomorrowKey;
  return day > tomorrowKey;
}

export function StaffOrdersScreen() {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>("decide");
  const [search, setSearch] = useState("");
  const [day, setDay] = useState<DayFilter>("all");
  const [stage, setStage] = useState<OrderStatus | "all">("all");

  async function reload(mode: "initial" | "refresh" | "silent") {
    if (mode === "initial") setLoading(true);
    if (mode === "refresh") setRefreshing(true);
    setError("");
    try {
      const [nextOrders, nextClaims] = await Promise.all([fetchAllOrders(), fetchClaims().catch(() => [] as Claim[])]);
      setOrders(nextOrders);
      setClaims(nextClaims);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les commandes."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload("initial");
    if (!realtime) return;
    const channel = realtime
      .channel("staff-orders")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders" }, (payload) => {
        void reload("silent");
        const created = payload.new as { order_number?: number };
        notify("Nouvelle commande", `La commande #${created.order_number ?? ""} attend votre décision.`);
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "orders" }, () => { void reload("silent"); })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "claims" }, () => {
        void reload("silent");
        notify("Nouvelle réclamation", "Un client a signalé un problème sur une commande.");
      })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  // Search and delivery-day filters apply to every section.
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return orders.filter((order) => matchesDay(order, day)
      && (!term || `${order.clients?.business_name ?? ""} ${order.address_snapshot?.point_label ?? ""} ${order.order_number}`.toLocaleLowerCase("fr").includes(term)));
  }, [orders, search, day]);

  const inGroup = (group: readonly string[]) => filtered.filter((order) => group.includes(order.status));
  const decide = inGroup(statusGroups.decide);
  const progress = inGroup(statusGroups.progress);
  const toPrepare = filtered.filter((order) => order.status === "confirmed" || order.status === "preparing");
  const openClaims = claims.filter((claim) => claim.status === "open" || claim.status === "in_progress");

  const sections: { key: Section; label: string }[] = [
    { key: "decide", label: `À décider (${decide.length})` },
    { key: "progress", label: `En cours (${progress.length})` },
    { key: "prepare", label: "Quantités à préparer" },
    { key: "claims", label: `Réclamations (${openClaims.length})` },
    { key: "done", label: "Historique" },
  ];

  const listed = useMemo(() => {
    const group = section === "decide" ? decide : section === "progress" ? progress : inGroup(statusGroups.done);
    const staged = section === "progress" && stage !== "all" ? group.filter((order) => order.status === stage) : group;
    // Work queues are ordered by requested delivery day, history by most recent.
    if (section === "done") return staged;
    return [...staged].sort((a, b) => (a.requested_delivery_date ?? "9999").localeCompare(b.requested_delivery_date ?? "9999") || a.order_number - b.order_number);
  }, [filtered, section, stage]);

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`ESPACE PERSONNEL · ${decide.length} À DÉCIDER · ${openClaims.length} RÉCLAMATION(S)`} title="Commandes" />
    <View style={styles.toolbar}>
      <TextInput value={search} onChangeText={setSearch} placeholder="Client, point de livraison ou n° de commande" placeholderTextColor={colors.muted} style={ui.input} />
    </View>
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {sections.map((item) => <Chip key={item.key} label={item.label} selected={section === item.key} onPress={() => setSection(item.key)} />)}
      </ScrollView>
      {section !== "claims" ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { paddingTop: 0 }]}>
        {dayFilters.map((item) => <Chip key={item.key} label={item.label} selected={day === item.key} onPress={() => setDay(item.key)} />)}
      </ScrollView> : null}
      {section === "progress" ? <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={[styles.chips, { paddingTop: 0 }]}>
        {(["all", ...statusGroups.progress] as const).map((item) => <Chip
          key={item}
          label={item === "all" ? "Toutes les étapes" : `${statusLabel(item)} (${progress.filter((order) => order.status === item).length})`}
          selected={stage === item}
          onPress={() => setStage(item)}
        />)}
      </ScrollView> : null}
    </View>

    {loading ? <Loading /> : section === "prepare" ? <PreparationView orders={toPrepare} refreshControl={refresh} />
      : section === "claims" ? <ClaimsView claims={claims} refreshControl={refresh} onChanged={() => void reload("silent")} />
      : <FlatList
        data={listed}
        keyExtractor={(order) => order.id}
        contentContainerStyle={ui.content}
        refreshControl={refresh}
        ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
        ListEmptyComponent={error ? null : <EmptyState title="Aucune commande" body="Aucune commande ne correspond à ces filtres." />}
        renderItem={({ item }) => <OrderCard order={item} claims={claims.filter((claim) => claim.order_id === item.id)} onChanged={() => void reload("silent")} onLocalUpdate={(updated) => setOrders((current) => current.map((order) => order.id === updated.id ? updated : order))} />}
      />}
  </View>;
}

function OrderCard({ order, claims, onChanged, onLocalUpdate }: {
  order: StaffOrder;
  claims: Claim[];
  onChanged: () => void;
  onLocalUpdate: (order: StaffOrder) => void;
}) {
  const [expanded, setExpanded] = useState(order.status === "pending");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const actions = staffActions[order.status as OrderStatus] ?? [];
  const needsReason = actions.some((action) => action.askReason);
  const address = order.address_snapshot ?? {};
  const clientName = order.clients?.business_name ?? address.business_name ?? address.recipient_name ?? "Client";
  const openClaims = claims.filter((claim) => claim.status === "open" || claim.status === "in_progress").length;

  async function apply(action: StaffAction) {
    setBusy(true);
    try {
      await updateOrderStatus(order.id, action.status, action.askReason ? reason : undefined);
      onLocalUpdate({ ...order, status: action.status, status_note: action.askReason ? reason.trim() || null : order.status_note });
      setReason("");
      onChanged();
    } catch (cause) {
      notify("Mise à jour impossible", errorMessage(cause, "Le statut n’a pas pu être modifié."));
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  function confirmAction(action: StaffAction) {
    if (action.status !== "declined" && action.status !== "cancelled") {
      void apply(action);
      return;
    }
    notify(action.status === "declined" ? "Décliner la commande" : "Annuler la commande", `Commande #${order.order_number} de ${clientName}.`, [
      { text: "Retour", style: "cancel" },
      { text: action.status === "declined" ? "Décliner" : "Annuler", style: "destructive", onPress: () => { void apply(action); } },
    ]);
  }

  async function printDeliveryNote() {
    setPrinting(true);
    try {
      await shareDeliveryNote(order, { showPrices: order.clients?.show_prices ?? true, showOrigin: order.clients?.show_origin ?? false });
    } catch (cause) {
      notify("Bon de livraison", errorMessage(cause, "Impossible de générer le PDF."));
    } finally {
      setPrinting(false);
    }
  }

  return <View style={ui.card}>
    <Pressable onPress={() => setExpanded((value) => !value)}>
      <View style={ui.row}>
        <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{expanded ? "▾" : "▸"} #{order.order_number} · {clientName}</Text>
        <StatusBadge status={order.status} />
      </View>
      <Text style={[ui.small, { marginTop: 3 }]}>
        {order.requested_delivery_date ? `Livraison ${formatDay(order.requested_delivery_date)}` : "Dès que possible"}
        {address.point_label ? ` · ${address.point_label}` : ""} · {order.order_items.length} produit(s) · {formatPrice(order.total)}
        {openClaims ? ` · ⚠ ${openClaims} réclamation(s)` : ""}
      </Text>
    </Pressable>

    {expanded ? <>
      <Text style={[ui.small, { marginTop: 6 }]}>
        {deliveryNoteNumber(order)} · {order.clients ? `${formatClientNumber(order.clients.client_number)} · ` : ""}reçue le {formatDateTime(order.created_at)}
      </Text>
      <Text style={ui.small}>{address.address_line}, {address.city}{address.phone ? ` · ${address.phone}` : ""}</Text>
      {order.customer_note ? <Text style={[ui.body, { color: colors.orange, fontStyle: "italic", marginTop: 4 }]}>« {order.customer_note} »</Text> : null}
      {order.status_note ? <Text style={[ui.small, { color: colors.amber }]}>Motif : {order.status_note}</Text> : null}
      {order.client_invoices && order.client_invoices.status !== "cancelled" ? <Text style={[ui.small, { color: colors.green, fontWeight: "700" }]}>Facture {order.client_invoices.invoice_number ?? "en brouillon"}{order.client_invoices.status === "paid" ? " · payée" : ""}</Text> : null}
      {order.delivered_at ? <Text style={[ui.small, { color: colors.green }]}>Livrée le {formatDateTime(order.delivered_at)}{order.delivered_by_profile?.full_name ? ` par ${order.delivered_by_profile.full_name}` : ""}</Text> : null}

      <View style={ui.divider}>
        {order.order_items.map((line, index) => <View key={`${order.id}-${index}`} style={ui.row}>
          <View style={{ flex: 1 }}>
            <Text style={ui.body}><Text style={{ fontWeight: "800" }}>{formatQuantity(line.quantity)} {line.unit_snapshot}</Text> · {line.product_name_snapshot}</Text>
            {line.origin_snapshot ? <Text style={styles.origin}>{formatOrigin(line.origin_snapshot)}</Text> : null}
          </View>
          <Text style={ui.small}>{formatPrice(line.line_total)}</Text>
        </View>)}
      </View>

      {claims.map((claim) => <Text key={claim.id} style={[ui.small, styles.claimLine]}>Réclamation n° {claim.claim_number} · {claimReasonLabel(claim.reason)} · {claimStatusStyle[claim.status].label}</Text>)}
      <OrderTimeline order={order} viewer="staff" />

      {needsReason ? <TextInput
        value={reason}
        onChangeText={setReason}
        placeholder={order.status === "declined" ? "Message au client (visible) : pourquoi reconfirmer ?" : "Motif (facultatif, visible par le client)"}
        placeholderTextColor={colors.muted}
        style={[ui.input, { marginTop: 10 }]}
      /> : null}
    </> : null}

    <View style={styles.actions}>
      {actions.filter((action) => expanded || action.variant === "primary").map((action) => <Button key={action.status} label={action.label} variant={action.variant} busy={busy && action.variant === "primary"} disabled={busy} onPress={() => confirmAction(action)} style={action.variant === "primary" ? { flexGrow: 1 } : undefined} />)}
      {expanded && ["confirmed", "preparing", "ready", "out_for_delivery", "delivered"].includes(order.status) ? <Button label="BON DE LIVRAISON" variant="secondary" busy={printing} onPress={() => void printDeliveryNote()} /> : null}
    </View>
    {order.status === "out_for_delivery" ? <Text style={[ui.small, { marginTop: 6 }]}>En attente des scans du livreur (bon de livraison + QR client).</Text> : null}
    {order.status === "awaiting_client" ? <Text style={[ui.small, { marginTop: 6, color: "#9a4f0f" }]}>En attente de la reconfirmation du client.</Text> : null}
  </View>;
}

function PreparationView({ orders, refreshControl }: { orders: StaffOrder[]; refreshControl: ReactElement<ComponentProps<typeof RefreshControl>> }) {
  const totals = useMemo(() => preparationTotals(orders), [orders]);
  const [open, setOpen] = useState<string[]>([]);
  const toggle = (key: string) => setOpen((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);

  return <ScrollView contentContainerStyle={ui.content} refreshControl={refreshControl}>
    <Text style={[ui.subtitle, { marginTop: 4 }]}>Total à préparer pour {orders.length} commande(s) acceptée(s) ou en préparation. Touchez un produit pour voir les clients concernés.</Text>
    {totals.length === 0 ? <EmptyState title="Rien à préparer" body="Les commandes acceptées apparaîtront ici." /> : <View style={ui.card}>
      {totals.map((line) => {
        const expanded = open.includes(line.key);
        return <View key={line.key} style={styles.totalBlock}>
          <Pressable onPress={() => toggle(line.key)} style={[ui.row, { paddingVertical: 10 }]}>
            <Text style={[ui.body, { flex: 1, fontWeight: expanded ? "800" : "400" }]}>{expanded ? "▾" : "▸"} {line.name}</Text>
            <Text style={ui.small}>{line.clients.length} client(s)</Text>
            <Text style={[ui.strong, { minWidth: 92, textAlign: "right" }]}>{formatQuantity(line.quantity)} {line.unit}</Text>
          </Pressable>
          {expanded ? <View style={styles.clientList}>
            {line.clients.map((entry) => <View key={entry.key} style={[ui.row, { paddingVertical: 4 }]}>
              <View style={{ flex: 1 }}>
                <Text style={ui.body}>{entry.name}</Text>
                <Text style={ui.small}>Cde {entry.orders.map((number) => `#${number}`).join(", ")}{entry.day ? ` · livraison ${formatDay(entry.day)}` : ""}</Text>
              </View>
              <Text style={[ui.body, { fontWeight: "800" }]}>{formatQuantity(entry.quantity)} {line.unit}</Text>
            </View>)}
          </View> : null}
        </View>;
      })}
    </View>}
  </ScrollView>;
}

const claimFilters: { key: "open" | "all"; label: string }[] = [
  { key: "open", label: "À traiter" },
  { key: "all", label: "Toutes" },
];

function ClaimsView({ claims, refreshControl, onChanged }: { claims: Claim[]; refreshControl: ReactElement<ComponentProps<typeof RefreshControl>>; onChanged: () => void }) {
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [responses, setResponses] = useState<Record<string, string>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const visible = filter === "open" ? claims.filter((claim) => claim.status === "open" || claim.status === "in_progress") : claims;

  async function change(claim: Claim, status: ClaimStatus) {
    setBusyId(claim.id);
    try {
      await updateClaim(claim.id, status, responses[claim.id]);
      setResponses((current) => ({ ...current, [claim.id]: "" }));
      onChanged();
    } catch (cause) {
      notify("Réclamation", errorMessage(cause, "La réclamation n’a pas pu être mise à jour."));
    } finally {
      setBusyId(null);
    }
  }

  return <FlatList
    data={visible}
    keyExtractor={(claim) => claim.id}
    contentContainerStyle={ui.content}
    refreshControl={refreshControl}
    ListHeaderComponent={<View style={[ui.wrapRow, { marginTop: 4 }]}>{claimFilters.map((item) => <Chip key={item.key} label={item.label} selected={filter === item.key} onPress={() => setFilter(item.key)} />)}</View>}
    ListEmptyComponent={<EmptyState title="Aucune réclamation" body={filter === "open" ? "Aucune réclamation en attente." : "Aucune réclamation enregistrée."} />}
    renderItem={({ item }) => {
      const style = claimStatusStyle[item.status];
      const closed = item.status === "resolved" || item.status === "rejected";
      return <View style={ui.card}>
        <View style={ui.row}>
          <Text style={[ui.strong, { flex: 1 }]}>N° {item.claim_number} · {item.clients?.business_name ?? ""}</Text>
          <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>
        </View>
        <Text style={ui.small}>Commande #{item.orders?.order_number ?? "?"} · {claimReasonLabel(item.reason)} · {formatDateTime(item.created_at)}</Text>
        <Text style={[ui.body, { marginTop: 6 }]}>{item.description}</Text>
        {item.staff_response ? <Text style={[ui.small, { marginTop: 6, color: colors.green }]}>Réponse : {item.staff_response}</Text> : null}
        {!closed ? <>
          <TextInput
            value={responses[item.id] ?? ""}
            onChangeText={(text) => setResponses((current) => ({ ...current, [item.id]: text }))}
            placeholder="Réponse au client (avoir, remplacement, explication…)"
            placeholderTextColor={colors.muted}
            style={[ui.input, { marginTop: 10 }]}
            multiline
          />
          <View style={styles.actions}>
            {item.status === "open" ? <Button label="PRENDRE EN CHARGE" variant="secondary" onPress={() => void change(item, "in_progress")} disabled={busyId === item.id} /> : null}
            <Button label="RÉSOUDRE" onPress={() => void change(item, "resolved")} busy={busyId === item.id} style={{ flexGrow: 1 }} />
            <Button label="REJETER" variant="danger" onPress={() => void change(item, "rejected")} disabled={busyId === item.id} />
          </View>
        </> : null}
      </View>;
    }}
  />;
}

const styles = StyleSheet.create({
  toolbar: { paddingHorizontal: 18, paddingTop: 12 },
  chips: { paddingHorizontal: 18, paddingVertical: 8, gap: 7 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  totalBlock: { borderBottomWidth: 1, borderBottomColor: colors.line },
  clientList: { paddingLeft: 18, paddingBottom: 10, gap: 2 },
  origin: { color: colors.green, fontSize: 10 },
  claimLine: { marginTop: 6, color: colors.amber, fontWeight: "700" },
});
