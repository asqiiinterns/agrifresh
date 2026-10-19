import { useEffect, useMemo, useState, type ComponentProps, type ReactElement } from "react";
import { FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { supabase } from "../lib/supabase";
import { formatClientNumber } from "../data/account";
import { claimReasonLabel, claimStatusStyle, fetchClaims, updateClaim, type Claim, type ClaimStatus } from "../data/claims";
import { deliveryNoteNumber, formatOrigin, shareDeliveryNote } from "../data/orders";
import { executionQueue, fetchAllOrders, staffActions, statusGroups, updateOrderStatus, type OrderStatus, type StaffAction, type StaffOrder } from "../data/staff";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { matchesDate, presets, type DateFilterValue } from "../ui/dateFilter";
import { PlanningScreen } from "./PlanningScreen";
import { useCan, type Feature } from "../data/permissions";

const actionFeature = (status: OrderStatus): Feature =>
  status === "preparing" || status === "ready" ? "production.update" : status === "out_for_delivery" ? "orders.ship" : "orders.decide";
import { Button, Chip, EmptyState, Loading, ScreenHeader, StatusBadge, formatDateTime, formatDay, formatPrice, formatQuantity, statusLabel } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { OrderTimeline } from "../ui/OrderTimeline";
import { colors, ui } from "../ui/theme";

type Section = "decide" | "queue" | "claims" | "done";

export function StaffOrdersScreen() {
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [section, setSection] = useState<Section>("decide");
  const [search, setSearch] = useState("");
  const [delivery, setDelivery] = useState<DateFilterValue>(null);
  const [placed, setPlaced] = useState<DateFilterValue>(null);
  const [stage, setStage] = useState<string>("all");
  const [planning, setPlanning] = useState<{ focusId: string | null } | null>(null);
  const can = useCan();

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

  // Search and date filters apply to every list.
  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return orders.filter((order) => matchesDate(order.requested_delivery_date, delivery) && matchesDate(order.created_at, placed)
      && (!term || `${order.clients?.business_name ?? ""} ${order.address_snapshot?.point_label ?? ""} ${order.order_number}`.toLocaleLowerCase("fr").includes(term)));
  }, [orders, search, delivery, placed]);

  const queue = useMemo(() => executionQueue(orders), [orders]);
  const positions = useMemo(() => new Map(queue.map((order, index) => [order.id, index + 1])), [queue]);
  const decide = filtered.filter((order) => (statusGroups.decide as readonly string[]).includes(order.status));
  const inProgress = filtered.filter((order) => (statusGroups.progress as readonly string[]).includes(order.status));
  const openClaims = claims.filter((claim) => claim.status === "open" || claim.status === "in_progress");

  const sections: { key: Section; label: string }[] = [
    { key: "decide", label: `À décider (${decide.length})` },
    { key: "queue", label: `En cours (${inProgress.length})` },
    ...(can("claims.manage") ? [{ key: "claims" as const, label: `Réclamations (${openClaims.length})` }] : []),
    { key: "done", label: "Historique" },
  ];

  const listed = useMemo(() => {
    if (section === "decide") {
      return [...decide].sort((a, b) => (a.requested_delivery_date ?? "9999").localeCompare(b.requested_delivery_date ?? "9999") || a.order_number - b.order_number);
    }
    if (section === "queue") {
      // Execution order first, shipped orders (no longer queued) after.
      const staged = stage === "all" ? inProgress : inProgress.filter((order) => order.status === stage);
      return [...staged].sort((a, b) => (positions.get(a.id) ?? 9999) - (positions.get(b.id) ?? 9999) || a.order_number - b.order_number);
    }
    return filtered.filter((order) => (statusGroups.done as readonly string[]).includes(order.status));
  }, [filtered, section, stage, positions]);

  const filters: Filter[] = [
    { kind: "date", title: "Livraison", presets: [presets.late, presets.today, presets.tomorrow, presets.next7, presets.noDate], value: delivery, onChange: setDelivery },
    ...(section === "queue" ? [{
      kind: "choice" as const,
      title: "Étape",
      options: [{ key: "all", label: "Toutes" }, ...statusGroups.progress.map((status) => ({ key: status, label: statusLabel(status), count: inProgress.filter((order) => order.status === status).length }))],
      value: stage,
      defaultValue: "all",
      onChange: setStage,
    }] : []),
    ...(section === "done" ? [{ kind: "date" as const, title: "Passée le", presets: [presets.today, presets.yesterday, presets.last7, presets.last30], value: placed, onChange: setPlaced }] : []),
  ];

  // Accepting puts the order at the end of the queue, then opens the queue to place it.
  async function accept(order: StaffOrder) {
    try {
      await updateOrderStatus(order.id, "confirmed");
      await reload("silent");
      if (can("orders.plan")) setPlanning({ focusId: order.id });
      else notify("Commande acceptée", `La commande #${order.order_number} est en fin de file de production.`);
    } catch (cause) {
      notify("Mise à jour impossible", errorMessage(cause, "La commande n’a pas pu être acceptée."));
    }
  }

  const refresh = <RefreshControl refreshing={refreshing} onRefresh={() => void reload("refresh")} tintColor={colors.green} />;

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow={`${decide.length} À DÉCIDER · ${queue.length} EN FILE · ${openClaims.length} RÉCLAMATION(S)`}
      title="Commandes"
      right={can("orders.plan") && queue.length ? <Button label="PLANIFIER" variant="secondary" onPress={() => setPlanning({ focusId: null })} /> : undefined}
    />
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {sections.map((item) => <Chip key={item.key} label={item.label} selected={section === item.key} onPress={() => setSection(item.key)} />)}
      </ScrollView>
    </View>
    {section !== "claims" ? <FilterBar search={search} onSearch={setSearch} placeholder="Client, point de livraison ou n°" filters={filters} /> : null}

    {loading ? <Loading /> : section === "claims" ? <ClaimsView claims={claims} refreshControl={refresh} onChanged={() => void reload("silent")} />
      : <FlatList
        data={listed}
        keyExtractor={(order) => order.id}
        contentContainerStyle={ui.content}
        refreshControl={refresh}
        ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text>
          : section === "queue" ? <Text style={[ui.small, { marginTop: 8 }]}>Ordre d’exécution de la production. « Planifier » ouvre la file pour monter, descendre ou insérer une commande.</Text> : null}
        ListEmptyComponent={error ? null : <EmptyState title="Aucune commande" body="Aucune commande ne correspond à ces filtres." />}
        renderItem={({ item }) => <OrderCard
          order={item}
          position={positions.get(item.id)}
          claims={claims.filter((claim) => claim.order_id === item.id)}
          onPlan={(mode) => { if (mode === "accept") void accept(item); else setPlanning({ focusId: item.id }); }}
          onChanged={() => void reload("silent")}
          onLocalUpdate={(updated) => setOrders((current) => current.map((order) => order.id === updated.id ? updated : order))}
        />}
      />}

    <PlanningScreen
      visible={planning !== null}
      focusId={planning?.focusId ?? null}
      queue={queue}
      onClose={() => setPlanning(null)}
      onChanged={() => reload("silent")}
    />
  </View>;
}

function OrderCard({ order, position, claims, onPlan, onChanged, onLocalUpdate }: {
  order: StaffOrder;
  position: number | undefined;
  claims: Claim[];
  onPlan: (mode: "accept" | "move") => void;
  onChanged: () => void;
  onLocalUpdate: (order: StaffOrder) => void;
}) {
  const [expanded, setExpanded] = useState(order.status === "pending");
  const can = useCan();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [printing, setPrinting] = useState(false);
  const actions = (staffActions[order.status as OrderStatus] ?? []).filter((action) => can(actionFeature(action.status)));
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
    if (action.status === "confirmed") {
      // Accepting = placing the order in the production queue.
      onPlan("accept");
      return;
    }
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
        {position ? <Text style={styles.position}>{position}</Text> : null}
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
      {position && can("orders.plan") ? <Button label="PLANIFIER" variant="secondary" onPress={() => onPlan("move")} /> : null}
      {expanded && ["confirmed", "preparing", "ready", "out_for_delivery", "delivered"].includes(order.status) ? <Button label="BON DE LIVRAISON" variant="secondary" busy={printing} onPress={() => void printDeliveryNote()} /> : null}
    </View>
    {order.status === "out_for_delivery" ? <Text style={[ui.small, { marginTop: 6 }]}>En attente des scans du livreur (bon de livraison + QR client).</Text> : null}
    {order.status === "awaiting_client" ? <Text style={[ui.small, { marginTop: 6, color: "#9a4f0f" }]}>En attente de la reconfirmation du client.</Text> : null}
  </View>;
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
  chips: { paddingHorizontal: 18, paddingVertical: 8, gap: 7 },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  origin: { color: colors.green, fontSize: 10 },
  claimLine: { marginTop: 6, color: colors.amber, fontWeight: "700" },
  position: { minWidth: 24, height: 24, borderRadius: 12, backgroundColor: colors.green, color: colors.white, textAlign: "center", lineHeight: 24, fontWeight: "800", fontSize: 12, paddingHorizontal: 4 },
});
