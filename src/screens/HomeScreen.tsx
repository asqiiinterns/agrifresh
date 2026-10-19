import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import type { Account } from "../data/account";
import { fetchAccounts } from "../data/admin";
import { fetchClaims } from "../data/claims";
import { useCan } from "../data/permissions";
import { fetchAllOrders, type StaffOrder } from "../data/staff";
import { Loading, toDayKey } from "../ui/components";
import { useNav, type IconName, type NavParams, type TabKey } from "../ui/navigation";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

type Tile = { key: string; label: string; value: number; icon: IconName; tone: "action" | "info" | "warn"; tab: TabKey; params?: NavParams };

// Team dashboard: what needs attention now, each figure opening the right screen.
export function HomeScreen({ account, unreadMessages, unreadAlerts }: { account: Account; unreadMessages: number; unreadAlerts: number }) {
  const can = useCan();
  const { navigate } = useNav();
  const [orders, setOrders] = useState<StaffOrder[]>([]);
  const [openClaims, setOpenClaims] = useState(0);
  const [pendingAccounts, setPendingAccounts] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const isAdmin = account.role === "admin";

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      const [nextOrders, claims, accounts] = await Promise.all([
        fetchAllOrders(),
        can("claims.manage") ? fetchClaims() : Promise.resolve([]),
        isAdmin ? fetchAccounts() : Promise.resolve([]),
      ]);
      setOrders(nextOrders);
      setOpenClaims(claims.filter((claim) => claim.status === "open" || claim.status === "in_progress").length);
      setPendingAccounts(accounts.filter((item) => item.status === "pending").length);
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger le tableau de bord."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime.channel("home-orders")
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload(); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, []);

  const tiles = useMemo<Tile[]>(() => {
    const count = (statuses: string[]) => orders.filter((order) => statuses.includes(order.status)).length;
    const today = toDayKey(new Date());
    const dueToday = orders.filter((order) => order.requested_delivery_date === today && !["delivered", "declined", "cancelled"].includes(order.status)).length;
    const list: (Tile | false)[] = [
      can("orders.decide") && { key: "decide", label: "À décider", value: count(["pending", "on_hold", "awaiting_client"]), icon: "hourglass-outline", tone: "action", tab: "orders", params: { section: "decide" } },
      { key: "prepare", label: "À préparer", value: count(["confirmed", "preparing"]), icon: "construct-outline", tone: "info", tab: can("production.view") ? "production" : "orders", params: can("production.view") ? undefined : { section: "queue" } },
      { key: "ready", label: "Prêtes à expédier", value: count(["ready"]), icon: "cube-outline", tone: "info", tab: can("deliveries") ? "deliveries" : "orders", params: can("deliveries") ? undefined : { section: "queue" } },
      { key: "shipping", label: "En livraison", value: count(["out_for_delivery"]), icon: "car-outline", tone: "info", tab: can("deliveries") ? "deliveries" : "orders", params: can("deliveries") ? undefined : { section: "queue" } },
      { key: "today", label: "À livrer aujourd’hui", value: dueToday, icon: "today-outline", tone: dueToday ? "warn" : "info", tab: "orders", params: { section: "queue" } },
      can("claims.manage") && { key: "claims", label: "Réclamations ouvertes", value: openClaims, icon: "alert-circle-outline", tone: openClaims ? "warn" : "info", tab: "orders", params: { section: "claims" } },
      isAdmin && { key: "accounts", label: "Comptes à valider", value: pendingAccounts, icon: "person-add-outline", tone: pendingAccounts ? "warn" : "info", tab: "admin", params: { page: "accounts" } },
      can("messages.manage") && { key: "messages", label: "Messages non lus", value: unreadMessages, icon: "chatbubbles-outline", tone: unreadMessages ? "action" : "info", tab: "messages" },
      { key: "alerts", label: "Alertes non lues", value: unreadAlerts, icon: "notifications-outline", tone: unreadAlerts ? "action" : "info", tab: "alerts" },
    ];
    return list.filter((tile): tile is Tile => tile !== false);
  }, [orders, openClaims, pendingAccounts, unreadMessages, unreadAlerts]);

  const shortcuts: { label: string; icon: IconName; tab: TabKey; params?: NavParams; show: boolean }[] = [
    { label: "Commander pour un client", icon: "add-circle-outline", tab: "staffOrder", show: can("orders.create") },
    { label: "Planifier la production", icon: "list-outline", tab: "orders", params: { section: "queue" }, show: can("orders.plan") },
    { label: "Quantités à préparer", icon: "construct-outline", tab: "production", show: can("production.view") },
    { label: "Fiches clients", icon: "people-outline", tab: "clients", show: can("clients.view") },
    { label: "Factures", icon: "document-text-outline", tab: "invoices", show: can("invoices.manage") },
  ];

  const hour = new Date().getHours();
  const greeting = hour < 18 ? "Bonjour" : "Bonsoir";
  const name = account.full_name?.split(" ")[0];

  return <View style={ui.screen}>
    <View style={styles.hero}>
      <Text style={styles.heroDate}>{new Date().toLocaleDateString("fr-TN", { weekday: "long", day: "numeric", month: "long" })}</Text>
      <Text style={styles.heroTitle}>{greeting}{name ? ` ${name}` : ""}</Text>
      <Text style={styles.heroBody}>Voici ce qui demande votre attention.</Text>
    </View>
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}>
      {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      <View style={styles.grid}>
        {tiles.map((tile) => <Pressable key={tile.key} onPress={() => navigate(tile.tab, tile.params)} style={({ pressed }) => [styles.tile, tile.tone === "warn" && tile.value > 0 && styles.tileWarn, tile.tone === "action" && tile.value > 0 && styles.tileAction, pressed && styles.pressed]}>
          <View style={styles.tileTop}>
            <Ionicons name={tile.icon} size={20} color={tile.value > 0 && tile.tone !== "info" ? (tile.tone === "warn" ? colors.amber : colors.green) : colors.muted} />
            <Ionicons name="chevron-forward" size={16} color={colors.muted} />
          </View>
          <Text style={styles.tileValue}>{tile.value}</Text>
          <Text style={styles.tileLabel} numberOfLines={2}>{tile.label}</Text>
        </Pressable>)}
      </View>

      {shortcuts.some((item) => item.show) ? <>
        <Text style={styles.sectionTitle}>Raccourcis</Text>
        <View style={styles.shortcuts}>
          {shortcuts.filter((item) => item.show).map((item) => <Pressable key={item.label} onPress={() => navigate(item.tab, item.params)} style={({ pressed }) => [styles.shortcut, pressed && styles.pressed]}>
            <View style={styles.shortcutIcon}><Ionicons name={item.icon} size={20} color={colors.green} /></View>
            <Text style={[ui.body, { flex: 1, fontWeight: "700" }]}>{item.label}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.muted} />
          </Pressable>)}
        </View>
      </> : null}
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  hero: { backgroundColor: colors.dark, paddingHorizontal: 20, paddingTop: 18, paddingBottom: 22 },
  heroDate: { color: "#c3d5b6", fontSize: 12, fontWeight: "700", textTransform: "capitalize" },
  heroTitle: { color: colors.white, fontSize: 26, fontWeight: "800", marginTop: 4 },
  heroBody: { color: "#d4dfd3", fontSize: 13, marginTop: 4 },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 10, marginTop: 14 },
  tile: { flexBasis: "47%", flexGrow: 1, backgroundColor: colors.white, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: colors.line, shadowColor: "#183c2a", shadowOpacity: 0.06, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 1 },
  tileAction: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  tileWarn: { borderColor: "#e3c46f", backgroundColor: "#fffbef" },
  tileTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tileValue: { color: colors.text, fontSize: 30, fontWeight: "800", marginTop: 8 },
  tileLabel: { color: colors.muted, fontSize: 12, fontWeight: "700", marginTop: 2 },
  sectionTitle: { color: colors.text, fontSize: 15, fontWeight: "800", marginTop: 22 },
  shortcuts: { marginTop: 8, backgroundColor: colors.white, borderRadius: 14, borderWidth: 1, borderColor: colors.line, overflow: "hidden" },
  shortcut: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 14, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line },
  shortcutIcon: { width: 36, height: 36, borderRadius: 10, backgroundColor: "#e6efe4", alignItems: "center", justifyContent: "center" },
  pressed: { opacity: 0.7 },
});
