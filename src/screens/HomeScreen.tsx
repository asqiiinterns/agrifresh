import { useEffect, useMemo, useState } from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { setMyHomeLayout, type Account } from "../data/account";
import { fetchAccounts } from "../data/admin";
import { fetchClaims } from "../data/claims";
import { balanceOf, fetchInvoices, isOverdue } from "../data/invoices";
import { decisionCount, fetchDecisionBoard, fetchWaitingMessages } from "../data/decisions";
import { fetchBillingBoard } from "../data/invoices";
import { fetchHomeCounts } from "../data/home";
import { isBuyerMode } from "../data/shared";
import { fetchLeaves } from "../data/workplace";
import { fetchCreditNotes, fetchReturns } from "../data/returns";
import { fetchMyOrders, type Order } from "../data/orders";
import { useCan } from "../data/permissions";
import { closedAt, fetchAllOrders } from "../data/staff";
import { fetchPickups, fetchShipments } from "../data/delivery";
import { Button, ListGroup, ListRow, Loading, ScreenHeader, toDayKey } from "../ui/components";
import { allowedFor, defaultLayout, homeShortcuts, homeTiles } from "../ui/homeCatalog";
import { useNav } from "../ui/navigation";
import { colors, ui } from "../ui/theme";
import { useModules } from "../data/modules";
import { HomeEditor } from "./HomeEditor";
import { HomeSearch } from "../ui/HomeSearch";
import { appLocale } from "../ui/i18n";

// Home: the figures that need attention and the user's shortcuts, both configurable.
export function HomeScreen({ account, unreadMessages, unreadAlerts, onLayoutChanged }: {
  account: Account;
  unreadMessages: number;
  unreadAlerts: number;
  onLayoutChanged: () => void;
}) {
  const can = useCan();
  const moduleOn = useModules();
  const customOn = useModules()("home_custom");
  const { navigate } = useNav();
  const isAdmin = account.role === "admin";
  const audience = account.role === "customer" ? "customer" : "team";
  const [values, setValues] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [editing, setEditing] = useState(false);

  const allowedTiles = homeTiles.filter((tile) => tile.audience === audience && allowedFor(tile, can, isAdmin, moduleOn));
  const allowedShortcuts = homeShortcuts.filter((item) => item.audience === audience && allowedFor(item, can, isAdmin, moduleOn));
  const layout = account.home_layout ?? defaultLayout(audience);
  const tiles = layout.tiles.map((key) => allowedTiles.find((tile) => tile.key === key)).filter((tile) => !!tile);
  const shortcuts = layout.shortcuts.map((key) => allowedShortcuts.find((item) => item.key === key)).filter((item) => !!item);
  const shows = (key: string) => tiles.some((tile) => tile.key === key);

  // fresh: pull to refresh or a change announced live (a request started before it is not reused).
  async function reload(refresh = false, fresh = refresh) {
    if (refresh) setRefreshing(true);
    const next: Record<string, number> = {};
    const today = toDayKey(new Date());
    const count = (orders: Order[], statuses: string[]) => orders.filter((order) => statuses.includes(order.status)).length;
    try {
      // Counted by the database (one small answer instead of every order and invoice).
      const counts = audience === "team" && !isBuyerMode() ? await fetchHomeCounts() : null;
      if (counts) {
        Object.assign(next, counts);
        const pendingShown = shows("pending");
        const ordersAllowed = can("orders.view") || can("orders.decide") || can("orders.plan");
        const deliveryLists = can("deliveries") && (shows("ready") || shows("shipping"));
        // The few lists that are not counts: each one only when a figure shown needs it.
        const [messages, billing, accounts, leaves, pickups, shipments] = await Promise.all([
          (pendingShown || shows("waitingReply")) && (can("messages.manage") || can("team.messages")) ? fetchWaitingMessages() : Promise.resolve(null),
          (pendingShown || shows("toInvoice")) && can("invoices.manage") ? fetchBillingBoard().catch(() => null) : Promise.resolve(null),
          (pendingShown || shows("accounts")) && isAdmin ? fetchAccounts().catch(() => []) : Promise.resolve([]),
          pendingShown && (can("leave.manage") || isAdmin) ? fetchLeaves(today, "2100-01-01").catch(() => []) : Promise.resolve([]),
          deliveryLists && shows("ready") && can("orders.ship") ? fetchPickups().catch(() => null) : Promise.resolve(null),
          deliveryLists && shows("shipping") ? fetchShipments().catch(() => null) : Promise.resolve(null),
        ]);
        // The same rules as « À décider »: each list only if the person may act on it.
        next.special = ordersAllowed ? counts.special ?? 0 : 0;
        next.reschedule = can("orders.plan") ? counts.reschedule ?? 0 : 0;
        next.waitingReply = messages ? messages.clients.length + messages.team.length : 0;
        next.toInvoice = billing ? billing.due.length : 0;
        next.accounts = accounts.filter((item) => item.status === "pending").length;
        if (pickups) next.ready = pickups.length;
        if (shipments) next.shipping = shipments.length;
        next.pending = (can("orders.decide") ? counts.decide ?? 0 : 0) + next.special + next.reschedule
          + (can("claims.manage") ? counts.claims ?? 0 : 0) + next.waitingReply
          + (billing ? billing.due.length + billing.overdue.length : 0)
          + (can("returns.manage") ? counts.returns ?? 0 : 0) + (isAdmin ? next.accounts : 0)
          + leaves.filter((leave) => leave.status === "pending" && !leave.mine).length
          + (can("incidents.manage") ? counts.incidents ?? 0 : 0);
      } else if (audience === "team") {
        const needsOrders = ["decide", "placedToday", "queue", "prepare", "ready", "shipping", "deliveredToday", "dueToday"].some(shows);
        const money = ["invoicedMonth", "collectedMonth", "outstanding", "overdue", "toInvoice"].some(shows);
        const decisions = ["pending", "special", "reschedule", "waitingReply", "toInvoice"].some(shows);
        // One wave: the decision board shares the orders, claims, returns and accounts requested here.
        // Delivery tiles count exactly what Livraisons lists (À récupérer / À livrer), also for a driver
        // who does not see every order.
        const deliveryLists = can("deliveries") && (shows("ready") || shows("shipping"));
        const [orders, claims, accounts, returns, credits, invoices, board, pickups, shipments] = await Promise.all([
          needsOrders ? fetchAllOrders(fresh).catch(() => []) : Promise.resolve([]),
          shows("claims") ? fetchClaims().catch(() => []) : Promise.resolve([]),
          shows("accounts") ? fetchAccounts().catch(() => []) : Promise.resolve([]),
          shows("returns") ? fetchReturns().catch(() => []) : Promise.resolve([]),
          shows("credits") ? fetchCreditNotes().catch(() => []) : Promise.resolve([]),
          money ? fetchInvoices().catch(() => []) : Promise.resolve([]),
          decisions ? fetchDecisionBoard(can, isAdmin).catch(() => null) : Promise.resolve(null),
          deliveryLists && shows("ready") && can("orders.ship") ? fetchPickups().catch(() => null) : Promise.resolve(null),
          deliveryLists && shows("shipping") ? fetchShipments().catch(() => null) : Promise.resolve(null),
        ]);
        const month = new Date().toISOString().slice(0, 7);
        const valid = invoices.filter((invoice) => invoice.status === "issued" || invoice.status === "paid");
        next.invoicedMonth = Math.round(valid.filter((invoice) => invoice.issued_at.slice(0, 7) === month).reduce((sum, invoice) => sum + Number(invoice.total_ttc), 0));
        next.collectedMonth = Math.round(valid.flatMap((invoice) => invoice.invoice_payments ?? []).filter((payment) => payment.paid_on.slice(0, 7) === month).reduce((sum, payment) => sum + Number(payment.amount), 0));
        next.outstanding = Math.round(valid.filter((invoice) => invoice.status === "issued").reduce((sum, invoice) => sum + balanceOf(invoice), 0));
        next.overdue = valid.filter(isOverdue).length;
        if (board) {
          next.pending = decisionCount(board);
          next.special = board.special.length;
          next.reschedule = board.reschedule.length;
          next.waitingReply = board.messages.clients.length + board.messages.team.length;
          next.toInvoice = board.billing.due.length;
        }
        next.returns = returns.filter((item) => ["requested", "approved", "received"].includes(item.status)).length;
        next.credits = credits.filter((item) => item.status === "draft" || item.status === "issued").length;
        next.decide = count(orders, ["pending", "on_hold", "awaiting_client"]);
        next.placedToday = orders.filter((order) => toDayKey(new Date(order.created_at)) === today).length;
        next.queue = count(orders, ["confirmed", "preparing", "ready"]);
        next.prepare = count(orders, ["confirmed", "preparing"]);
        next.ready = pickups ? pickups.length : count(orders, ["ready"]);
        next.shipping = shipments ? shipments.length : count(orders, ["out_for_delivery"]);
        // Delivered today, whatever the day they were placed (the same orders as Clôturées → « Clôturées le : aujourd'hui »).
        next.deliveredToday = orders.filter((order) => order.status === "delivered" && toDayKey(new Date(closedAt(order))) === today).length;
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
      .on("postgres_changes", { event: "*", schema: "public", table: "orders" }, () => { void reload(false, true); })
      .subscribe();
    return () => { void realtime.removeChannel(channel); };
  }, [layout.tiles.join(",")]);

  const valueOf = (key: string) => key === "messages" || key === "c_messages" ? unreadMessages
    : key === "alerts" || key === "c_alerts" ? unreadAlerts
    : values[key] ?? 0;

  const today = new Date().toLocaleDateString(appLocale(), { weekday: "long", day: "numeric", month: "long" });
  const name = audience === "customer" ? account.client?.business_name : account.full_name?.split(" ")[0];

  return <View style={ui.screen}>
    <ScreenHeader
      eyebrow={today.toLocaleUpperCase("fr")}
      title={`${new Date().getHours() < 18 ? "Bonjour" : "Bonsoir"}${name ? ` ${name}` : ""}`}
      right={customOn ? <Pressable onPress={() => setEditing(true)} style={styles.gear} hitSlop={8} accessibilityLabel="Personnaliser l’accueil">
        <Ionicons name="settings-outline" size={20} color={colors.primary} />
      </Pressable> : undefined}
    />
    {/* Gear next to the greeting: choose and order the figures and shortcuts shown here. */}
    <HomeEditor
      visible={editing}
      title="Mon accueil"
      tiles={allowedTiles.map(({ key, label, icon }) => ({ key, label, icon }))}
      shortcuts={allowedShortcuts.map(({ key, label, icon }) => ({ key, label, icon }))}
      value={layout}
      resetLabel={account.role_home_layout ? "REVENIR À L’ACCUEIL DE MON PROFIL" : "REVENIR À L’ACCUEIL PAR DÉFAUT"}
      onSave={async (next) => { await setMyHomeLayout(next); onLayoutChanged(); }}
      onReset={async () => { await setMyHomeLayout(null); onLayoutChanged(); }}
      onClose={() => setEditing(false)}
    />
    {/* Search: any function, setting, order or client, in one place. */}
    <View style={[ui.pageInner, { paddingHorizontal: 14 }]}>
      <HomeSearch audience={audience} can={can} isAdmin={isAdmin} moduleOn={moduleOn} />
    </View>
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}>
      {tiles.length ? <View style={styles.grid}>
        {tiles.map((tile) => {
          const value = valueOf(tile.key);
          const highlight = value > 0 && tile.tone;
          return <Pressable key={tile.key} onPress={() => navigate(tile.tab, tile.params)} style={({ pressed }) => [styles.tile, highlight === "action" && styles.tileAction, highlight === "warn" && styles.tileWarn, pressed && { opacity: 0.7 }]}>
            <View style={styles.tileTop}>
              <Text style={styles.tileValue}>{value}</Text>
              <Ionicons name={tile.icon} size={16} color={highlight === "warn" ? colors.amber : highlight ? colors.primary : colors.muted} />
            </View>
            <Text style={styles.tileLabel} numberOfLines={2}>{tile.label}</Text>
          </Pressable>;
        })}
      </View> : null}

      {shortcuts.length ? <ListGroup title="Raccourcis">
        {shortcuts.map((item) => <ListRow key={item.key} icon={item.icon} title={item.label} onPress={() => navigate(item.tab, item.params)} />)}
      </ListGroup> : null}

      {!tiles.length && !shortcuts.length ? <Text style={[ui.small, { marginTop: 14 }]}>Votre accueil est vide : touchez ⚙ en haut pour choisir vos chiffres et raccourcis.</Text> : null}
    </ScrollView>}

  </View>;
}

// Compte → Accueil: choose and order the figures and shortcuts of one's home screen.
export function HomeCustomizeCard({ account, onLayoutChanged }: { account: Account; onLayoutChanged: () => void }) {
  const can = useCan();
  const moduleOn = useModules();
  const isAdmin = account.role === "admin";
  const audience = account.role === "customer" ? "customer" : "team";
  const [editing, setEditing] = useState(false);
  const layout = account.home_layout ?? defaultLayout(audience);
  const tiles = homeTiles.filter((tile) => tile.audience === audience && allowedFor(tile, can, isAdmin, moduleOn)).map(({ key, label, icon }) => ({ key, label, icon }));
  const shortcuts = homeShortcuts.filter((item) => item.audience === audience && allowedFor(item, can, isAdmin, moduleOn)).map(({ key, label, icon }) => ({ key, label, icon }));
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
  gear: { width: 40, height: 40, borderRadius: 20, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white, alignItems: "center", justifyContent: "center" },
  edit: { flexDirection: "row", alignItems: "center", gap: 4, borderWidth: 1, borderColor: colors.line, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: colors.white },
  editText: { color: colors.primary, fontSize: 11, fontWeight: "800" },
  grid: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  tile: { flexBasis: "31%", flexGrow: 1, backgroundColor: colors.white, borderRadius: 10, paddingHorizontal: 10, paddingVertical: 8, borderWidth: 1, borderColor: colors.line },
  tileAction: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
  tileWarn: { borderColor: "#e3c46f", backgroundColor: "#fffbef" },
  tileTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  tileValue: { color: colors.text, fontSize: 20, fontWeight: "800" },
  tileLabel: { color: colors.muted, fontSize: 11, fontWeight: "700", marginTop: 1 },
});
