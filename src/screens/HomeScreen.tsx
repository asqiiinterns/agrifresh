import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { setMyHomeLayout, type Account } from "../data/account";
import { fetchAccounts } from "../data/admin";
import { fetchClaims } from "../data/claims";
import { fetchInvoices } from "../data/invoices";
import { fetchMyOrders, type Order } from "../data/orders";
import { useCan } from "../data/permissions";
import { fetchAllOrders } from "../data/staff";
import { Button, ListGroup, ListRow, Loading, ScreenHeader, toDayKey } from "../ui/components";
import { allowedFor, defaultLayout, homeShortcuts, homeTiles } from "../ui/homeCatalog";
import { useNav } from "../ui/navigation";
import { colors, ui } from "../ui/theme";
import { HomeEditor } from "./HomeEditor";

// Home: the figures that need attention and the user's shortcuts, both configurable.
export function HomeScreen({ account, unreadMessages, unreadAlerts, onLayoutChanged }: {
  account: Account;
  unreadMessages: number;
  unreadAlerts: number;
  onLayoutChanged: () => void;
}) {
  const can = useCan();
  const { navigate } = useNav();
  const isAdmin = account.role === "admin";
  const audience = account.role === "customer" ? "customer" : "team";
  const [values, setValues] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const allowedTiles = homeTiles.filter((tile) => tile.audience === audience && allowedFor(tile.need, can, isAdmin));
  const allowedShortcuts = homeShortcuts.filter((item) => item.audience === audience && allowedFor(item.need, can, isAdmin));
  const layout = account.home_layout ?? defaultLayout(audience);
  const tiles = layout.tiles.map((key) => allowedTiles.find((tile) => tile.key === key)).filter((tile) => !!tile);
  const shortcuts = layout.shortcuts.map((key) => allowedShortcuts.find((item) => item.key === key)).filter((item) => !!item);
  const shows = (key: string) => tiles.some((tile) => tile.key === key);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    const next: Record<string, number> = {};
    const today = toDayKey(new Date());
    const count = (orders: Order[], statuses: string[]) => orders.filter((order) => statuses.includes(order.status)).length;
    try {
      if (audience === "team") {
        const needsOrders = ["decide", "placedToday", "queue", "prepare", "ready", "shipping", "dueToday"].some(shows);
        const [orders, claims, accounts] = await Promise.all([
          needsOrders ? fetchAllOrders().catch(() => []) : Promise.resolve([]),
          shows("claims") ? fetchClaims().catch(() => []) : Promise.resolve([]),
          shows("accounts") ? fetchAccounts().catch(() => []) : Promise.resolve([]),
        ]);
        next.decide = count(orders, ["pending", "on_hold", "awaiting_client"]);
        next.placedToday = orders.filter((order) => toDayKey(new Date(order.created_at)) === today).length;
        next.queue = count(orders, ["confirmed", "preparing", "ready"]);
        next.prepare = count(orders, ["confirmed", "preparing"]);
        next.ready = count(orders, ["ready"]);
        next.shipping = count(orders, ["out_for_delivery"]);
        next.dueToday = orders.filter((order) => order.requested_delivery_date === today && !["delivered", "declined", "cancelled"].includes(order.status)).length;
        next.claims = claims.filter((claim) => claim.status === "open" || claim.status === "in_progress").length;
        next.accounts = accounts.filter((item) => item.status === "pending").length;
      } else {
        const [orders, invoices] = await Promise.all([
          fetchMyOrders().catch(() => [] as Order[]),
          shows("c_invoices") ? fetchInvoices().catch(() => []) : Promise.resolve([]),
        ]);
        next.c_progress = count(orders, ["pending", "on_hold", "confirmed", "preparing", "ready", "out_for_delivery"]);
        next.c_reconfirm = count(orders, ["awaiting_client"]);
        next.c_shipped = count(orders, ["out_for_delivery"]);
        next.c_invoices = invoices.filter((invoice) => invoice.status === "issued").length;
      }
      setValues(next);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const realtime = supabase;
    void reload();
    if (!realtime) return;
    const channel = realtime.channel(`home-${audience}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload(); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, [layout.tiles.join(",")]);

  const valueOf = (key: string) => key === "messages" || key === "c_messages" ? unreadMessages
    : key === "alerts" || key === "c_alerts" ? unreadAlerts
    : values[key] ?? 0;

  const today = new Date().toLocaleDateString("fr-TN", { weekday: "long", day: "numeric", month: "long" });
  const name = audience === "customer" ? account.client?.business_name : account.full_name?.split(" ")[0];

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow={today.toLocaleUpperCase("fr")}
      title={`${new Date().getHours() < 18 ? "Bonjour" : "Bonsoir"}${name ? ` ${name}` : ""}`}
    />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}>
      {tiles.length ? <View style={styles.grid}>
        {tiles.map((tile) => {
          const value = valueOf(tile.key);
          const highlight = value > 0 && tile.tone;
          return <Pressable key={tile.key} onPress={() => navigate(tile.tab, tile.params)} style={({ pressed }) => [styles.tile, highlight === "action" && styles.tileAction, highlight === "warn" && styles.tileWarn, pressed && { opacity: 0.7 }]}>
            <View style={styles.tileTop}>
              <Text style={styles.tileValue}>{value}</Text>
              <Ionicons name={tile.icon} size={16} color={highlight === "warn" ? colors.amber : highlight ? colors.green : colors.muted} />
            </View>
            <Text style={styles.tileLabel} numberOfLines={2}>{tile.label}</Text>
          </Pressable>;
        })}
      </View> : null}

      {shortcuts.length ? <ListGroup title="Raccourcis">
        {shortcuts.map((item) => <ListRow key={item.key} icon={item.icon} title={item.label} onPress={() => navigate(item.tab, item.params)} />)}
      </ListGroup> : null}

      {!tiles.length && !shortcuts.length ? <Text style={[ui.small, { marginTop: 14 }]}>Votre accueil est vide : choisissez vos chiffres et raccourcis dans Compte → Accueil.</Text> : null}
    </ScrollView>}

  </View>;
}

// Compte → Accueil: choose and order the figures and shortcuts of one's home screen.
export function HomeCustomizeCard({ account, onLayoutChanged }: { account: Account; onLayoutChanged: () => void }) {
  const can = useCan();
  const isAdmin = account.role === "admin";
  const audience = account.role === "customer" ? "customer" : "team";
  const [editing, setEditing] = useState(false);
  const layout = account.home_layout ?? defaultLayout(audience);
  const tiles = homeTiles.filter((tile) => tile.audience === audience && allowedFor(tile.need, can, isAdmin)).map(({ key, label, icon }) => ({ key, label, icon }));
  const shortcuts = homeShortcuts.filter((item) => item.audience === audience && allowedFor(item.need, can, isAdmin)).map(({ key, label, icon }) => ({ key, label, icon }));
  return <View style={ui.card}>
    <Text style={ui.strong}>Mon accueil</Text>
    <Text style={ui.small}>{account.home_layout ? "Personnalisé" : account.role_home_layout ? "Accueil de votre profil" : "Accueil standard"} : {layout.tiles.length} chiffre(s), {layout.shortcuts.length} raccourci(s).</Text>
    <Button label="PERSONNALISER L’ACCUEIL" onPress={() => setEditing(true)} style={{ marginTop: 10 }} />
    <HomeEditor
      visible={editing}
      title="Mon accueil"
      tiles={tiles}
      shortcuts={shortcuts}
      value={layout}
      resetLabel={account.role_home_layout ? "REVENIR À L’ACCUEIL DE MON PROFIL" : "REVENIR À L’ACCUEIL PAR DÉFAUT"}
      onSave={async (next) => { await setMyHomeLayout(next); onLayoutChanged(); }}
      onReset={async () => { await setMyHomeLayout(null); onLayoutChanged(); }}
      onClose={() => setEditing(false)}
    />
  </View>;
}

const styles = StyleSheet.create({
  edit: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.white },
  editText: { color: colors.green, fontSize: 11, fontWeight: "800" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  tile: { flexBasis: "31%", flexGrow: 1, backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: colors.line },
  tileAction: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
  tileWarn: { borderColor: "#e3c46f", backgroundColor: "#fffbef" },
  tileTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tileValue: { color: colors.text, fontSize: 20, fontWeight: "800" },
  tileLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", marginTop: 1 },
});
