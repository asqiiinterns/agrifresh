import { useEffect, useMemo, useState } from "react";
import { RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import type { StaffOrder } from "../data/staff";
import { fetchOrdersSince } from "../data/workplace";
import { Chip, Loading, ScreenHeader, Sheets, formatPrice, formatQuantity, toDayKey } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { BarList, ColumnChart, Tile, type Point } from "./BillingDashboard";
import { appLocale } from "../ui/i18n";

type Period = "30" | "90" | "365";
type Sheet = "overview" | "products" | "clients" | "slots" | "preparation";
const count = (value: number) => formatQuantity(Math.round(value));
const hours = (value: number) => value < 1 ? `${Math.round(value * 60)} min` : `${value.toFixed(1)} h`;
const firstEvent = (order: StaffOrder, status: string) => order.order_status_history?.filter((event) => event.status === status).map((event) => event.created_at).sort()[0];
const gapHours = (from?: string, to?: string) => from && to ? (new Date(to).getTime() - new Date(from).getTime()) / 3600000 : null;
const average = (values: (number | null)[]) => { const list = values.filter((value): value is number => value !== null && value >= 0); return list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0; };

// Statistics: orders over time, products consumed, clients, time slots, preparation times.
export function StatsScreen() {
  const [period, setPeriod] = useState<Period>("90");
  const [sheet, setSheet] = useState<Sheet>("overview");
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [clientKey, setClientKey] = useState<string | null>(null);
  const [productKey, setProductKey] = useState<string | null>(null);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setOrders(await fetchOrdersSince(new Date(Date.now() - Number(period) * 86400000).toISOString()));
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les statistiques."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, [period]);

  const stats = useMemo(() => {
    const valid = orders.filter((order) => !["declined", "cancelled"].includes(order.status));
    const bucket = (iso: string) => period === "365" ? iso.slice(0, 7) : weekKey(iso);
    const buckets = [...new Set(valid.map((order) => bucket(order.created_at)))].sort();
    const label = (key: string) => period === "365" ? new Date(`${key}-15T12:00:00`).toLocaleDateString(appLocale(), { month: "short" }) : `S${key.slice(-2)}`;
    const series = (list: StaffOrder[], value: (order: StaffOrder) => number): Point[] => buckets.map((key) => ({ key, label: label(key), value: list.filter((order) => bucket(order.created_at) === key).reduce((sum, order) => sum + value(order), 0) }));

    const products = new Map<string, { label: string; unit: string; quantity: number; amount: number; byClient: Map<string, number> }>();
    for (const order of valid) for (const line of order.order_items) {
      const key = line.product_id ?? line.product_name_snapshot;
      const entry = products.get(key) ?? { label: line.product_name_snapshot, unit: line.unit_snapshot, quantity: 0, amount: 0, byClient: new Map() };
      entry.quantity += Number(line.quantity);
      entry.amount += Number(line.line_total);
      const client = order.clients?.business_name ?? "Client";
      entry.byClient.set(client, (entry.byClient.get(client) ?? 0) + Number(line.quantity));
      products.set(key, entry);
    }
    const clients = new Map<string, { label: string; amount: number; orders: StaffOrder[] }>();
    for (const order of valid) {
      const key = order.client_id ?? "?";
      const entry = clients.get(key) ?? { label: order.clients?.business_name ?? "Client", amount: 0, orders: [] };
      entry.amount += Number(order.total);
      entry.orders.push(order);
      clients.set(key, entry);
    }
    const slots = Array.from({ length: 12 }, (_, index) => ({ key: String(index), label: `${index * 2}h`, value: 0 }));
    const deliverySlots = Array.from({ length: 12 }, (_, index) => ({ key: String(index), label: `${index * 2}h`, value: 0 }));
    const weekdays = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((day, index) => ({ key: String(index), label: day, value: 0 }));
    for (const order of valid) {
      const created = new Date(order.created_at);
      slots[Math.floor(created.getHours() / 2)].value += 1;
      weekdays[(created.getDay() + 6) % 7].value += 1;
      if (order.delivered_at) deliverySlots[Math.floor(new Date(order.delivered_at).getHours() / 2)].value += 1;
    }
    const delivered = valid.filter((order) => order.status === "delivered");
    const onTime = delivered.filter((order) => order.requested_delivery_date && order.delivered_at && toDayKey(new Date(order.delivered_at)) <= order.requested_delivery_date);
    const withDate = delivered.filter((order) => order.requested_delivery_date);
    const prepTimes = valid.map((order) => gapHours(firstEvent(order, "preparing"), firstEvent(order, "ready")));
    const acceptToReady = valid.map((order) => gapHours(firstEvent(order, "confirmed"), firstEvent(order, "ready")));
    const decision = valid.map((order) => gapHours(order.created_at, firstEvent(order, "confirmed")));
    const orderToDelivery = delivered.map((order) => gapHours(order.created_at, order.delivered_at ?? undefined));
    const prepByWeekday = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"].map((day, index) => ({ key: String(index), label: day,
      value: average(valid.filter((order) => (new Date(order.created_at).getDay() + 6) % 7 === index).map((order) => gapHours(firstEvent(order, "preparing"), firstEvent(order, "ready")))) }));

    return {
      total: valid.length,
      revenue: valid.reduce((sum, order) => sum + Number(order.total), 0),
      basket: valid.length ? valid.reduce((sum, order) => sum + Number(order.total), 0) / valid.length : 0,
      declined: orders.length - valid.length,
      onTimeRate: withDate.length ? Math.round(onTime.length / withDate.length * 100) : null,
      ordersSeries: series(valid, () => 1),
      revenueSeries: series(valid, (order) => Number(order.total)),
      products: [...products.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.amount - a.amount),
      clients: [...clients.entries()].map(([key, value]) => ({ key, ...value })).sort((a, b) => b.amount - a.amount),
      clientSeries: (key: string) => series(clients.get(key)?.orders ?? [], (order) => Number(order.total)),
      slots, deliverySlots, weekdays,
      prep: { prepare: average(prepTimes), acceptToReady: average(acceptToReady), decision: average(decision), toDelivery: average(orderToDelivery), byWeekday: prepByWeekday },
    };
  }, [orders, period]);

  const selectedClient = stats.clients.find((item) => item.key === clientKey) ?? stats.clients[0];
  const selectedProduct = stats.products.find((item) => item.key === productKey);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${stats.total} COMMANDE(S) SUR LA PÉRIODE`} title="Statistiques" />
    <Sheets items={[{ key: "overview", label: "Évolution" }, { key: "products", label: "Produits" }, { key: "clients", label: "Clients" }, { key: "slots", label: "Créneaux" }, { key: "preparation", label: "Préparation" }]} value={sheet} onChange={setSheet} />
    <View style={[ui.wrapRow, { paddingHorizontal: 14, paddingTop: 8 }]}>
      <Chip label="30 jours" selected={period === "30"} onPress={() => setPeriod("30")} />
      <Chip label="90 jours" selected={period === "90"} onPress={() => setPeriod("90")} />
      <Chip label="12 mois" selected={period === "365"} onPress={() => setPeriod("365")} />
    </View>
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}>
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      {sheet === "overview" ? <>
        <View style={styles.tiles}>
          <Tile label="Commandes" value={count(stats.total)} />
          <Tile label="Chiffre d’affaires HT" value={formatPrice(stats.revenue)} />
          <Tile label="Panier moyen" value={formatPrice(stats.basket)} />
          <Tile label="Livrées à la date souhaitée" value={stats.onTimeRate === null ? "—" : `${stats.onTimeRate} %`} warn={stats.onTimeRate !== null && stats.onTimeRate < 80} />
          <Tile label="Déclinées / annulées" value={count(stats.declined)} />
        </View>
        <ColumnChart title={period === "365" ? "Commandes par mois" : "Commandes par semaine"} points={stats.ordersSeries} format={count} />
        <ColumnChart title={period === "365" ? "Chiffre d’affaires par mois" : "Chiffre d’affaires par semaine"} points={stats.revenueSeries} />
      </> : null}

      {sheet === "products" ? <>
        <BarList title="Consommation par produit (montant)" points={stats.products.slice(0, 15).map((item) => ({ key: item.key, label: `${item.label} · ${formatQuantity(item.quantity)} ${item.unit}`, value: item.amount }))} empty="Aucune commande sur la période." />
        <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Détail d’un produit par client</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>{stats.products.slice(0, 15).map((item) => <Chip key={item.key} label={item.label} selected={productKey === item.key} onPress={() => setProductKey(item.key)} />)}</View>
        {selectedProduct ? <BarList title={`${selectedProduct.label} : quantités par client`} points={[...selectedProduct.byClient.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([label, value]) => ({ key: label, label, value }))} empty="—" format={(value) => `${formatQuantity(value)} ${selectedProduct.unit}`} /> : null}
      </> : null}

      {sheet === "clients" ? <>
        <BarList title="Clients par chiffre d’affaires" points={stats.clients.slice(0, 15).map((item) => ({ key: item.key, label: `${item.label} · ${item.orders.length} cde`, value: item.amount }))} empty="Aucune commande sur la période." />
        <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Évolution d’un client</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>{stats.clients.slice(0, 15).map((item) => <Chip key={item.key} label={item.label} selected={selectedClient?.key === item.key} onPress={() => setClientKey(item.key)} />)}</View>
        {selectedClient ? <ColumnChart title={`${selectedClient.label} : chiffre d’affaires`} points={stats.clientSeries(selectedClient.key)} /> : null}
      </> : null}

      {sheet === "slots" ? <>
        <ColumnChart title="Heure de passage des commandes" points={stats.slots} format={count} />
        <ColumnChart title="Heure de livraison" points={stats.deliverySlots} format={count} />
        <ColumnChart title="Commandes par jour de la semaine" points={stats.weekdays} format={count} />
      </> : null}

      {sheet === "preparation" ? <>
        <View style={styles.tiles}>
          <Tile label="Décision (réception → acceptation)" value={hours(stats.prep.decision)} />
          <Tile label="Préparation (début → prête)" value={hours(stats.prep.prepare)} />
          <Tile label="Acceptation → prête" value={hours(stats.prep.acceptToReady)} />
          <Tile label="Commande → livraison" value={hours(stats.prep.toDelivery)} />
        </View>
        <ColumnChart title="Durée moyenne de préparation par jour" points={stats.prep.byWeekday} format={hours} />
        <Text style={[ui.small, { marginTop: 8 }]}>Calculé à partir de l’historique des statuts (heure de chaque étape).</Text>
      </> : null}
    </ScrollView>}
  </View>;
}

// ISO week "2026-W43".
function weekKey(iso: string) {
  const date = new Date(iso);
  const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = target.getUTCDay() || 7;
  target.setUTCDate(target.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(target.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((target.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${target.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const styles = StyleSheet.create({
  tiles: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
});
