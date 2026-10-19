import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Platform, Pressable, StatusBar, StyleSheet, View } from "react-native";
import { Text } from "./src/ui/Text";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./src/lib/supabase";
import { fetchMyAccount, type Account } from "./src/data/account";
import { PermissionsContext } from "./src/data/permissions";
import { DisplayProvider } from "./src/ui/display";
import { alertTarget, countUnreadAlerts, markAlertsRead } from "./src/data/alerts";
import { AlertsScreen } from "./src/screens/AlertsScreen";
import { hasPushToken, onAlertTapped, registerForPush, showLocalAlert } from "./src/notifications";
import { ProductionScreen } from "./src/screens/ProductionScreen";
import { AdminScreen } from "./src/screens/AdminScreen";
import { countUnread } from "./src/data/messages";
import { AuthScreen } from "./src/screens/AuthScreen";
import { AccountScreen } from "./src/screens/AccountScreen";
import { OrderScreen } from "./src/screens/OrderScreen";
import { ClientOrdersScreen } from "./src/screens/ClientOrdersScreen";
import { StaffOrdersScreen } from "./src/screens/StaffOrdersScreen";
import { StaffClientsScreen } from "./src/screens/StaffClientsScreen";
import { StaffInvoicesScreen } from "./src/screens/StaffInvoicesScreen";
import { ClientInvoicesScreen } from "./src/screens/ClientInvoicesScreen";
import { DocumentViewerHost } from "./src/ui/DocumentViewer";
import { DriverScreen } from "./src/screens/DriverScreen";
import { ClientMessagesScreen, StaffInboxScreen } from "./src/screens/MessagesScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { PlanningTab } from "./src/screens/PlanningScreen";
import { MoreScreen } from "./src/screens/MoreScreen";
import { StaffOrderEntryScreen } from "./src/screens/StaffOrderEntryScreen";
import { Ionicons } from "@expo/vector-icons";
import { NavContext, type IconName, type NavParams, type TabDef, type TabKey } from "./src/ui/navigation";
import { Button, EmptyState, Loading } from "./src/ui/components";
import { errorMessage, notify } from "./src/ui/notify";
import { colors, ui } from "./src/ui/theme";

const TAB = {
  home: { key: "home", label: "Accueil", icon: "home-outline", description: "Tableau de bord du moment." },
  order: { key: "order", label: "Commander", icon: "add-circle-outline" },
  staffOrder: { key: "staffOrder", label: "Commander", icon: "add-circle-outline", description: "Saisir une commande pour un client." },
  alerts: { key: "alerts", label: "Alertes", icon: "notifications-outline", description: "Notifications reçues." },
  orders: { key: "orders", label: "Commandes", icon: "receipt-outline", description: "À décider, en cours, clôturées, réclamations." },
  planning: { key: "planning", label: "Planning", icon: "list-outline", description: "File de production : ordre d’exécution." },
  production: { key: "production", label: "Production", icon: "construct-outline", description: "Quantités à préparer." },
  deliveries: { key: "deliveries", label: "Livraisons", icon: "car-outline", description: "Récupérer, livrer, historique." },
  clients: { key: "clients", label: "Clients", icon: "people-outline", description: "Fiches, points de livraison, QR codes." },
  invoices: { key: "invoices", label: "Factures", icon: "document-text-outline", description: "Factures et bons de livraison." },
  messages: { key: "messages", label: "Messages", icon: "chatbubbles-outline", description: "Échanges avec les clients." },
  admin: { key: "admin", label: "Admin", icon: "settings-outline", description: "Comptes, droits, produits, alertes." },
  account: { key: "account", label: "Compte", icon: "person-circle-outline", description: "Profil, affichage, déconnexion." },
  more: { key: "more", label: "Plus", icon: "grid-outline" },
} satisfies Record<TabKey, TabDef>;

// Bottom bar: at most five entries, the rest goes into "Plus".
const MAX_BAR = 5;

// Tabs follow the features the admin enabled for the account's role, most used first.
function tabsFor(account: Account): { kind: "client" | "unlinked" | "team"; tabs: TabDef[] } {
  const has = (feature: string) => account.features.includes(feature);
  const add = (tabs: TabDef[], tab: TabDef, allowed: boolean) => { if (allowed && !tabs.includes(tab)) tabs.push(tab); };
  if (account.role === "customer") {
    if (!account.client) return { kind: "unlinked", tabs: [TAB.account] };
    const tabs: TabDef[] = [];
    add(tabs, TAB.home, has("client.home"));
    add(tabs, TAB.order, has("client.order"));
    add(tabs, TAB.orders, has("client.orders"));
    add(tabs, TAB.messages, has("client.messages"));
    add(tabs, TAB.alerts, has("client.alerts"));
    add(tabs, TAB.invoices, has("client.invoices"));
    tabs.push(TAB.account);
    return { kind: "client", tabs };
  }
  const tabs: TabDef[] = [];
  add(tabs, TAB.home, has("home.view"));
  // The driver's and the production team's own work comes right after.
  add(tabs, TAB.deliveries, account.role === "driver" && has("deliveries"));
  add(tabs, TAB.production, account.role === "production" && has("production.view"));
  add(tabs, TAB.orders, has("orders.view"));
  // Planning stays in the bottom bar: it is the key daily task.
  add(tabs, TAB.planning, has("orders.plan"));
  add(tabs, TAB.staffOrder, has("orders.create"));
  add(tabs, TAB.messages, has("messages.manage"));
  add(tabs, TAB.alerts, has("alerts.view"));
  if (has("production.view") && !tabs.includes(TAB.production)) tabs.push(TAB.production);
  if (has("deliveries") && !tabs.includes(TAB.deliveries)) tabs.push(TAB.deliveries);
  if (has("clients.view")) tabs.push(TAB.clients);
  if (has("invoices.manage")) tabs.push(TAB.invoices);
  add(tabs, TAB.admin, account.role === "admin" || has("fleet.manage") || has("audit.view"));
  tabs.push(TAB.account);
  return { kind: "team", tabs };
}

function splitBar(tabs: TabDef[]): { bar: TabDef[]; overflow: TabDef[] } {
  if (tabs.length <= MAX_BAR) return { bar: tabs, overflow: [] };
  return { bar: [...tabs.slice(0, MAX_BAR - 1), TAB.more], overflow: tabs.slice(MAX_BAR - 1) };
}

const filledIcon = (icon: IconName) => icon.replace(/-outline$/, "") as IconName;

function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(!supabase);

  useEffect(() => {
    if (!supabase) return;
    let active = true;
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      if (active) setSession(nextSession);
    });
    void supabase.auth.getSession().then(({ data: sessionData }) => {
      if (!active) return;
      setSession(sessionData.session);
      setReady(true);
    });
    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  return { session, ready };
}

// E-mail confirmation and password recovery links open the app with one-time tokens.
function useAuthCallback() {
  useEffect(() => {
    if (!supabase) return;
    const authClient = supabase;

    async function handle(url: string | null) {
      if (!url) return;
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(url);
      } catch {
        return;
      }
      const query = parsedUrl.searchParams;
      const fragment = new URLSearchParams(parsedUrl.hash.replace(/^#/, ""));
      const isAuthCallback = ["code", "access_token", "error_description"].some((key) => query.has(key) || fragment.has(key));
      if (!isAuthCallback) return;
      try {
        const errorDescription = query.get("error_description") ?? fragment.get("error_description");
        if (errorDescription) {
          notify("Lien de connexion", decodeURIComponent(errorDescription.replace(/\+/g, " ")));
          return;
        }
        const code = query.get("code");
        if (code) {
          const { error } = await authClient.auth.exchangeCodeForSession(code);
          if (error) throw error;
        } else {
          const accessToken = fragment.get("access_token") ?? query.get("access_token");
          const refreshToken = fragment.get("refresh_token") ?? query.get("refresh_token");
          if (!accessToken || !refreshToken) return;
          const { error } = await authClient.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (error) throw error;
        }
        const recovery = (fragment.get("type") ?? query.get("type")) === "recovery";
        notify(recovery ? "Connexion réussie" : "Accès activé", recovery ? "Choisissez un nouveau mot de passe dans l’onglet Compte." : "Votre compte est maintenant connecté.");
      } catch (error) {
        notify("Lien de connexion", errorMessage(error, "Le lien est invalide ou expiré."));
      } finally {
        // Drop one-time tokens from the address bar so a reload does not replay them.
        if (Platform.OS === "web" && typeof window !== "undefined") {
          window.history.replaceState(null, "", window.location.pathname);
        }
      }
    }

    const subscription = Linking.addEventListener("url", ({ url }) => { void handle(url); });
    void Linking.getInitialURL().then(handle);
    return () => subscription.remove();
  }, []);
}

// Unread alerts badge; without push (Expo Go, web) a live alert also shows a local banner.
function useUnreadAlerts(userId: string | null) {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (!userId) return;
    void countUnreadAlerts().then(setUnread);
  }, [userId]);

  useEffect(() => {
    const client = supabase;
    if (!userId || !client) {
      setUnread(0);
      return;
    }
    refresh();
    const channel = client
      .channel(`alerts-badge-${userId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${userId}` }, (payload) => {
        refresh();
        const alert = payload.new as { id?: string; event?: string; order_id?: string | null; title?: string; body?: string };
        if (!hasPushToken() && alert.title) void showLocalAlert(alert.title, alert.body ?? "", { event: alert.event, order_id: alert.order_id, id: alert.id });
      })
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [userId, refresh]);

  return { unread, refresh };
}

function useUnreadMessages(enabled: boolean, isStaff: boolean) {
  const [unread, setUnread] = useState(0);
  const refresh = useCallback(() => {
    if (!enabled) return;
    void countUnread(isStaff).then(setUnread);
  }, [enabled, isStaff]);

  useEffect(() => {
    const client = supabase;
    if (!enabled || !client) {
      setUnread(0);
      return;
    }
    refresh();
    const channel = client
      .channel(`unread-${isStaff ? "staff" : "client"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refresh)
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [enabled, isStaff, refresh]);

  return { unread, refresh };
}

function Main({ session }: { session: Session }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [accountError, setAccountError] = useState("");
  const [nav, setNav] = useState<{ tab: TabKey | null; params?: NavParams; nonce: number }>({ tab: null, nonce: 0 });
  const tab = nav.tab;
  const [ordersKey, setOrdersKey] = useState(0);
  // A tile or shortcut opens a tab at a given section; each call remounts the target screen.
  const navigate = useCallback((next: TabKey, params?: NavParams) => setNav((state) => ({ tab: next, params, nonce: state.nonce + 1 })), []);
  const setTab = useCallback((next: TabKey | null) => setNav((state) => ({ tab: next, nonce: state.nonce })), []);
  const navValue = useMemo(() => ({ navigate }), [navigate]);

  const loadAccount = useCallback(async () => {
    setAccountError("");
    try {
      setAccount(await fetchMyAccount());
    } catch (cause) {
      setAccountError(errorMessage(cause, "Impossible de charger votre profil."));
    }
  }, []);

  useEffect(() => {
    setAccount(null);
    setTab(null);
    void loadAccount();
  }, [session.user.id, loadAccount]);

  const { kind, tabs } = account ? tabsFor(account) : { kind: null, tabs: [] as TabDef[] };
  const { bar, overflow } = splitBar(tabs);
  const current = tab && (tabs.some((item) => item.key === tab) || (tab === "more" && overflow.length > 0)) ? tab : tabs[0]?.key;
  const barCurrent = overflow.some((item) => item.key === current) ? "more" : current;
  const permissions = useMemo(() => new Set(account?.features ?? []), [account]);
  const { unread, refresh: refreshUnread } = useUnreadMessages(tabs.some((item) => item.key === "messages"), kind === "team");
  const isActive = !!account && (account.status ?? "active") === "active";
  const alerts = useUnreadAlerts(isActive ? session.user.id : null);

  // Register this phone for lock-screen alerts once the account is active; a tap opens Alertes.
  useEffect(() => {
    if (!isActive) return;
    void registerForPush(true);
    return onAlertTapped((data) => {
      if (data.id) void markAlertsRead([data.id]).then(alerts.refresh).catch(() => {});
      const target = alertTarget(data.event, data.order_id, account?.role !== "customer");
      navigate(target.tab, target.params);
    });
  }, [isActive, session.user.id, navigate, account?.role]);

  if (!account) {
    return accountError
      ? <EmptyState title="Profil indisponible" body={accountError} action={<Button label="RÉESSAYER" onPress={() => void loadAccount()} />} />
      : <Loading label="Chargement de votre espace…" />;
  }

  // Accounts work only once an admin has made them active.
  const status = account.status ?? (account.disabled ? "suspended" : "active");
  if (status !== "active") {
    const message = {
      pending: { title: "Compte en attente de validation", body: "Votre compte est créé. AgriFresh doit le valider avant que vous puissiez l’utiliser ; touchez « Actualiser » une fois prévenu." },
      refused: { title: "Demande refusée", body: "AgriFresh n’a pas validé ce compte. Contactez-nous si vous pensez qu’il s’agit d’une erreur." },
      suspended: { title: "Compte suspendu", body: "Votre accès est suspendu par AgriFresh. Contactez l’administrateur pour le réactiver." },
    }[status];
    return <View style={{ flex: 1 }}>
      <EmptyState title={message.title} body={message.body} action={<Button label="ACTUALISER" variant="secondary" onPress={() => void loadAccount()} />} />
      <AccountScreen session={session} account={account} />
    </View>;
  }

  function renderTab() {
    if (!account) return null;
    switch (current) {
      case "home":
        return <HomeScreen account={account} unreadMessages={unread} unreadAlerts={alerts.unread} onLayoutChanged={() => void loadAccount()} />;
      case "planning":
        return <PlanningTab />;
      case "more":
        return <MoreScreen items={overflow} badges={{ messages: unread, alerts: alerts.unread }} />;
      case "staffOrder":
        return <StaffOrderEntryScreen onPlaced={() => navigate("orders", { section: "decide" })} />;
      case "order":
        return account.client ? <OrderScreen client={account.client} onPlaced={() => { setOrdersKey((key) => key + 1); setTab("orders"); }} /> : null;
      case "orders":
        return kind === "team" ? <StaffOrdersScreen initialSection={nav.params?.section} initialOrderId={nav.params?.orderId} /> : account.client ? <ClientOrdersScreen key={ordersKey} session={session} client={account.client} initialOrderId={nav.params?.orderId} /> : null;
      case "messages":
        return kind === "team" ? <StaffInboxScreen onRead={refreshUnread} /> : account.client ? <ClientMessagesScreen clientId={account.client.id} onRead={refreshUnread} /> : null;
      case "clients":
        return <StaffClientsScreen />;
      case "production":
        return <ProductionScreen />;
      case "invoices":
        return kind === "team" ? <StaffInvoicesScreen /> : <ClientInvoicesScreen />;
      case "deliveries":
        return <DriverScreen />;
      case "alerts":
        return <AlertsScreen userId={session.user.id} team={kind === "team"} onRead={alerts.refresh} />;
      case "admin":
        return <AdminScreen isAdmin={account.role === "admin"} initialPage={nav.params?.page} />;
      default:
        return <View style={{ flex: 1 }}>
          {kind === "unlinked" ? <View style={[ui.card, { marginHorizontal: 18, marginTop: 18 }]}>
            <Text style={ui.strong}>Compte non rattaché</Text>
            <Text style={[ui.body, { marginTop: 6 }]}>Aucune fiche client active ne correspond à {session.user.email}. Demandez à AgriFresh de créer ou d’activer votre fiche avec cette adresse, puis touchez « Actualiser ».</Text>
            <Button label="ACTUALISER" variant="secondary" onPress={() => void loadAccount()} style={{ marginTop: 12 }} />
          </View> : null}
          <AccountScreen session={session} account={account} />
        </View>;
    }
  }

  const badgeFor = (key: TabKey) => key === "messages" ? unread
    : key === "alerts" ? alerts.unread
    : key === "more" ? overflow.reduce((sum, item) => sum + (item.key === "messages" ? unread : item.key === "alerts" ? alerts.unread : 0), 0)
    : 0;

  return <PermissionsContext.Provider value={permissions}><NavContext.Provider value={navValue}>
    <View key={`${current}-${nav.nonce}`} style={{ flex: 1 }}>{renderTab()}</View>
    {bar.length > 1 ? <View style={styles.tabBar}>
      {bar.map((item) => {
        const selected = item.key === barCurrent;
        const badge = badgeFor(item.key);
        return <Pressable key={item.key} onPress={() => setTab(item.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={item.label}>
          <View style={[styles.tabPill, selected && styles.tabPillActive]}>
            <Ionicons name={selected ? filledIcon(item.icon) : item.icon} size={22} color={selected ? colors.green : "#8a9187"} />
            {badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text></View> : null}
          </View>
          <Text style={[styles.tabLabel, selected && styles.tabActive]} numberOfLines={1}>{item.label}</Text>
        </Pressable>;
      })}
    </View> : null}
  </NavContext.Provider></PermissionsContext.Provider>;
}

export default function App() {
  const { session, ready } = useSession();
  useAuthCallback();

  return <DisplayProvider><SafeAreaProvider>
    <SafeAreaView style={ui.screen} edges={["top", "left", "right", "bottom"]}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.paper} />
      {!isSupabaseConfigured
        ? <EmptyState title="Configuration manquante" body="Renseignez EXPO_PUBLIC_SUPABASE_URL et EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY." />
        : !ready ? <Loading />
        : session ? <Main session={session} />
        : <AuthScreen />}
      <DocumentViewerHost />
    </SafeAreaView>
  </SafeAreaProvider></DisplayProvider>;
}

const styles = StyleSheet.create({
  tabBar: { flexDirection: "row", paddingTop: 6, paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  tab: { flex: 1, alignItems: "center", gap: 3, paddingHorizontal: 2 },
  tabPill: { width: 56, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  tabPillActive: { backgroundColor: "#e3eee0" },
  tabLabel: { color: "#8a9187", fontSize: 11, fontWeight: "600" },
  tabActive: { color: colors.green, fontWeight: "800" },
  badge: { position: "absolute", top: -3, right: 4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  badgeText: { color: colors.white, fontSize: 9, fontWeight: "800" },
});
