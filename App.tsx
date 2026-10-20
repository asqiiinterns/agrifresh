import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Platform, Pressable, StatusBar, StyleSheet, View } from "react-native";
import { Text } from "./src/ui/Text";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./src/lib/supabase";
import { fetchMyAccount, type Account } from "./src/data/account";
import { PermissionsContext } from "./src/data/permissions";
import { DisplayProvider } from "./src/ui/display";
import { alertTarget, countUnreadAlerts, fetchAlertConversation, markAlertsRead } from "./src/data/alerts";
import { AlertsScreen } from "./src/screens/AlertsScreen";
import { askPushOnce, hasPushToken, onAlertTapped, registerForPush, showLocalAlert, unregisterPush } from "./src/notifications";
import { DecideScreen } from "./src/screens/DecideScreen";
import { decisionCount, fetchDecisionBoard } from "./src/data/decisions";
import { ProductionScreen } from "./src/screens/ProductionScreen";
import { AdminScreen } from "./src/screens/AdminScreen";
import { countUnread } from "./src/data/messages";
import { countTeamUnread } from "./src/data/teamMessages";
import { AuthScreen } from "./src/screens/AuthScreen";
import { AccountScreen } from "./src/screens/AccountScreen";
import { OrderScreen } from "./src/screens/OrderScreen";
import { ClientOrdersScreen } from "./src/screens/ClientOrdersScreen";
import { StaffOrdersScreen } from "./src/screens/StaffOrdersScreen";
import { StaffClientsScreen } from "./src/screens/StaffClientsScreen";
import { StaffInvoicesScreen } from "./src/screens/StaffInvoicesScreen";
import { ClientInvoicesScreen } from "./src/screens/ClientInvoicesScreen";
import { DocumentViewerHost } from "./src/ui/DocumentViewer";
import { DialogHost } from "./src/ui/DialogHost";
import { DriverScreen } from "./src/screens/DriverScreen";
import { ClientMessagesScreen, StaffMessagesScreen } from "./src/screens/MessagesScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { PlanningTab } from "./src/screens/PlanningScreen";
import { ProductionHub, type HubSheet } from "./src/screens/ProductionHub";
import { ReturnsScreen } from "./src/screens/ReturnsScreen";
import { CalendarScreen } from "./src/screens/CalendarScreen";
import { IncidentsScreen, LeavesScreen } from "./src/screens/StaffLifeScreens";
import { StatsScreen } from "./src/screens/StatsScreen";
import { RecurringScreen, runRecurringOrders } from "./src/screens/RecurringScreen";
import { sendMyLocation } from "./src/data/workplace";
import { AppState } from "react-native";
import { MoreScreen } from "./src/screens/MoreScreen";
import { StaffOrderEntryScreen } from "./src/screens/StaffOrderEntryScreen";
import { Ionicons } from "@expo/vector-icons";
import { NavContext, type IconName, type NavParams, type TabDef, type TabKey } from "./src/ui/navigation";
import { Button, EmptyState, Loading } from "./src/ui/components";
import { errorMessage, notify } from "./src/ui/notify";
import { colors, ui } from "./src/ui/theme";

const TAB = {
  home: { key: "home", label: "Accueil", icon: "home-outline", description: "Tableau de bord du moment." },
  decide: { key: "decide", label: "À décider", icon: "flag-outline", description: "Tout ce qui est en suspens." },
  order: { key: "order", label: "Commander", icon: "add-circle-outline" },
  staffOrder: { key: "staffOrder", label: "Commander", icon: "add-circle-outline", description: "Saisir une commande pour un client." },
  alerts: { key: "alerts", label: "Alertes", icon: "notifications-outline", description: "Notifications reçues." },
  orders: { key: "orders", label: "Commandes", icon: "receipt-outline", description: "À décider, en cours, clôturées, réclamations." },
  planning: { key: "planning", label: "Planning", icon: "list-outline", description: "File de production : ordre d’exécution." },
  production: { key: "production", label: "Production", icon: "construct-outline", description: "Commandes, production et planning." },
  deliveries: { key: "deliveries", label: "Livraisons", icon: "car-outline", description: "Récupérer, livrer, historique." },
  clients: { key: "clients", label: "Clients", icon: "people-outline", description: "Fiches, points de livraison, QR codes." },
  invoices: { key: "invoices", label: "Factures", icon: "document-text-outline", description: "Factures et bons de livraison." },
  messages: { key: "messages", label: "Messages", icon: "chatbubbles-outline", description: "Échanges avec les clients et entre collègues." },
  calendar: { key: "calendar", label: "Calendrier", icon: "calendar-outline", description: "Livraisons, échéances, absences et rappels." },
  leaves: { key: "leaves", label: "Congés", icon: "airplane-outline", description: "Demandes, validation, absences à venir." },
  incidents: { key: "incidents", label: "Incidents", icon: "warning-outline", description: "Signaler un problème de livraison ou de véhicule." },
  recurring: { key: "recurring", label: "Commandes récurrentes", icon: "repeat-outline", description: "Commandes créées automatiquement chaque semaine." },
  stats: { key: "stats", label: "Statistiques", icon: "stats-chart-outline", description: "Produits, clients, créneaux, temps de préparation." },
  returns: { key: "returns", label: "Retours et avoirs", icon: "return-down-back-outline", description: "Demandes de retour, réception, avoirs." },
  admin: { key: "admin", label: "Admin", icon: "settings-outline", description: "Comptes, droits, produits, alertes." },
  account: { key: "account", label: "Plus", icon: "grid-outline", description: "Rubriques, personnaliser, compte, autorisations." },
  more: { key: "more", label: "Plus", icon: "grid-outline" },
} satisfies Record<TabKey, TabDef>;

// Bottom bar: at most five entries, the rest goes into "Plus".
const MAX_BAR = 6;
// Messages and alerts have their own icons at the top of the screen, with a badge.
const TOP_KEYS: TabKey[] = ["messages", "alerts"];
// Commandes and Planning live as sheets inside "Production" for the team.
const HUB_KEYS: TabKey[] = ["orders", "planning", "production"];

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
    add(tabs, TAB.recurring, has("client.recurring"));
    tabs.push(TAB.account);
    return { kind: "client", tabs };
  }
  // Main menu: Accueil, Production (Commandes · Production · Planning), Facturation, Livraisons; the rest in "Plus".
  const tabs: TabDef[] = [];
  add(tabs, TAB.home, has("home.view"));
  add(tabs, TAB.decide, account.role === "admin" || ["orders.decide", "orders.plan", "claims.manage", "messages.manage", "team.messages", "invoices.manage", "returns.manage", "leave.manage", "incidents.manage"].some(has));
  add(tabs, TAB.production, has("orders.view") || has("production.view") || has("orders.plan"));
  add(tabs, { ...TAB.invoices, label: "Facturation" }, has("invoices.manage"));
  add(tabs, TAB.deliveries, has("deliveries"));
  add(tabs, TAB.staffOrder, has("orders.create"));
  add(tabs, TAB.returns, has("returns.manage"));
  add(tabs, TAB.calendar, has("calendar.view"));
  add(tabs, TAB.leaves, has("leave.request") || has("leave.manage"));
  add(tabs, TAB.incidents, has("incidents.report") || has("incidents.manage"));
  add(tabs, TAB.stats, has("stats.view"));
  add(tabs, TAB.recurring, has("orders.create"));
  add(tabs, TAB.messages, has("messages.manage") || has("team.messages"));
  add(tabs, TAB.alerts, has("alerts.view"));
  tabs.push(TAB.account);
  return { kind: "team", tabs };
}

// "Compte" closes the bar; the sections that do not fit are listed in Compte → Rubriques.
function splitBar(tabs: TabDef[]): { bar: TabDef[]; overflow: TabDef[] } {
  if (tabs.length <= MAX_BAR) return { bar: tabs, overflow: [] };
  const main = tabs.filter((item) => item.key !== "account");
  return { bar: [...main.slice(0, MAX_BAR - 1), TAB.account], overflow: main.slice(MAX_BAR - 1) };
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

// Unread client messages plus, for the team, unread messages between colleagues.
function useUnreadMessages(enabled: boolean, isStaff: boolean, sources: { clients: boolean; team: boolean }) {
  const [unread, setUnread] = useState(0);
  const { clients, team } = sources;
  const refresh = useCallback(() => {
    if (!enabled) return;
    void Promise.all([clients ? countUnread(isStaff) : 0, team ? countTeamUnread() : 0]).then(([a, b]) => setUnread(a + b));
  }, [enabled, isStaff, clients, team]);

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
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "team_messages" }, refresh)
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
  const { bar, overflow } = splitBar(tabs.filter((item) => !TOP_KEYS.includes(item.key)));
  // Commandes / Planning requested by a tile, an alert or a button open the matching sheet of "Production".
  const hub = kind === "team" && tabs.some((item) => item.key === "production");
  // Former "Plus" and client records now live in Compte.
  const accountSheet = tab === "more" ? "sections" : tab === "clients" ? "clients" : tab === "account" ? nav.params?.section : undefined;
  const requested = hub && tab && HUB_KEYS.includes(tab) ? "production" : tab === "more" || tab === "clients" ? "account" : tab;
  const hubSheet: HubSheet | undefined = tab === "orders" ? "orders" : tab === "planning" ? "planning"
    : nav.params?.section === "prepare" || nav.params?.section === "planning" || nav.params?.section === "orders" ? nav.params.section as HubSheet : undefined;
  const current = requested && tabs.some((item) => item.key === requested) ? requested : bar[0]?.key ?? tabs[0]?.key;
  const barCurrent = overflow.some((item) => item.key === current) ? "account" : current;
  const permissions = useMemo(() => new Set(account?.features ?? []), [account]);
  const { unread, refresh: refreshUnread } = useUnreadMessages(tabs.some((item) => item.key === "messages"), kind === "team", {
    clients: kind !== "team" || !!account?.features.includes("messages.manage"),
    team: kind === "team" && !!account?.features.includes("team.messages"),
  });
  const isActive = !!account && (account.status ?? "active") === "active";
  // Recurring orders due today are created when the team opens the app (also hourly by pg_cron if enabled).
  useEffect(() => {
    if (isActive && account && account.role !== "customer" && (account.features.includes("orders.create") || account.features.includes("orders.decide"))) void runRecurringOrders().catch(() => {});
  }, [isActive, account?.role]);

  // Position shared only by accounts that agreed (Plus → Autorisations), only while the app is open.
  useEffect(() => {
    if (!isActive || !account?.features.includes("location.share")) return;
    void sendMyLocation();
    const timer = setInterval(() => { if (AppState.currentState === "active") void sendMyLocation(); }, 5 * 60 * 1000);
    const subscription = AppState.addEventListener("change", (state) => { if (state === "active") void sendMyLocation(); });
    return () => { clearInterval(timer); subscription.remove(); };
  }, [isActive, account?.features.join(",")]);

  // Badge of « À décider », refreshed every two minutes (and live while the screen is open).
  const [decideCount, setDecideCount] = useState(0);
  const hasDecide = tabs.some((item) => item.key === "decide");
  useEffect(() => {
    if (!isActive || !hasDecide || !account) return;
    const can = (feature: string) => account.features.includes(feature);
    const load = () => { void fetchDecisionBoard(can as never, account.role === "admin").then((board) => setDecideCount(decisionCount(board))).catch(() => {}); };
    load();
    const timer = setInterval(load, 120000);
    return () => clearInterval(timer);
  }, [isActive, hasDecide, account?.features.join(",")]);
  const alerts = useUnreadAlerts(isActive ? session.user.id : null);

  // Register this phone for lock-screen alerts once the account is active; a tap opens Alertes.
  useEffect(() => {
    if (!isActive) return;
    void askPushOnce().then((ask) => registerForPush(ask));
    return onAlertTapped((data) => {
      if (data.id) void markAlertsRead([data.id]).then(alerts.refresh).catch(() => {});
      void (data.event === "team.message" && data.id ? fetchAlertConversation(data.id).catch(() => null) : Promise.resolve(null)).then((conversationId) => {
        const target = alertTarget(data.event, data.order_id, account?.role !== "customer", conversationId);
        navigate(target.tab, { ...target.params, back: "alerts" });
      });
    });
  }, [isActive, session.user.id, navigate, account?.role]);

  if (!account) {
    return accountError
      ? <EmptyState title="Profil indisponible" body={accountError} action={<Button label="RÉESSAYER" onPress={() => loadAccount()} />} />
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
      <EmptyState title={message.title} body={message.body} action={<Button label="ACTUALISER" variant="secondary" onPress={() => loadAccount()} />} />
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
      case "staffOrder":
        return <StaffOrderEntryScreen onPlaced={() => navigate("orders", { section: "decide" })} />;
      case "order":
        return account.client ? <OrderScreen client={account.client} onPlaced={() => { setOrdersKey((key) => key + 1); setTab("orders"); }} /> : null;
      case "orders":
        return kind === "team" ? <StaffOrdersScreen initialSection={nav.params?.section} initialOrderId={nav.params?.orderId} /> : account.client ? <ClientOrdersScreen key={ordersKey} session={session} client={account.client} initialOrderId={nav.params?.orderId} /> : null;
      case "messages":
        return kind === "team" ? <StaffMessagesScreen canClients={account.features.includes("messages.manage")} canTeam={account.features.includes("team.messages")} initialSection={nav.params?.section} initialConversationId={nav.params?.page} onRead={refreshUnread} /> : account.client ? <ClientMessagesScreen clientId={account.client.id} onRead={refreshUnread} /> : null;
      case "production":
        return kind === "team" ? <ProductionHub initialSheet={hubSheet} ordersSection={tab === "orders" ? nav.params?.section : undefined} orderId={nav.params?.orderId} /> : null;
      case "invoices":
        return kind === "team" ? <StaffInvoicesScreen /> : <ClientInvoicesScreen initialSheet={nav.params?.section} />;
      case "decide":
        return <DecideScreen isAdmin={account.role === "admin"} onCount={setDecideCount} />;
      case "calendar":
        return <CalendarScreen />;
      case "leaves":
        return <LeavesScreen isAdmin={account.role === "admin"} />;
      case "incidents":
        return <IncidentsScreen />;
      case "recurring":
        return <RecurringScreen team={kind === "team"} />;
      case "stats":
        return <StatsScreen />;
      case "returns":
        return <ReturnsScreen initialSheet={nav.params?.section} initialOrderId={nav.params?.orderId} />;
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
            <Button label="ACTUALISER" variant="secondary" onPress={() => loadAccount()} style={{ marginTop: 12 }} />
          </View> : null}
          <AccountScreen session={session} account={account} sections={overflow} initialSheet={accountSheet} onLayoutChanged={() => void loadAccount()} />
        </View>;
    }
  }

  const badgeFor = (key: TabKey) => key === "messages" ? unread : key === "alerts" ? alerts.unread : key === "decide" ? decideCount : 0;
  const topTabs = tabs.filter((item) => TOP_KEYS.includes(item.key));

  return <PermissionsContext.Provider value={permissions}><NavContext.Provider value={navValue}>
    <View style={styles.topBar}>
      <Text style={styles.brand}>AgriFresh</Text>
      <View style={{ flex: 1 }} />
      {topTabs.map((item) => {
        const selected = item.key === current;
        const badge = badgeFor(item.key);
        if (item.key === "messages") return <MessagesButton key={item.key} selected={selected} unread={badge} onPress={() => setTab(item.key)} />;
        return <Pressable key={item.key} onPress={() => setTab(item.key)} style={[styles.topIcon, selected && styles.tabPillActive]} accessibilityLabel={`${item.label}${badge ? `, ${badge} non lu(s)` : ""}`} hitSlop={6}>
          <Ionicons name={selected ? filledIcon(item.icon) : item.icon} size={22} color={selected ? colors.green : colors.text} />
          {badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text></View> : null}
        </Pressable>;
      })}
      <Pressable onPress={confirmSignOut} style={styles.topIcon} accessibilityLabel="Se déconnecter" hitSlop={6}>
        <Ionicons name="log-out-outline" size={22} color={colors.danger} />
      </Pressable>
    </View>
    {nav.params?.back && nav.params.back !== current ? <Pressable onPress={() => setTab(nav.params!.back!)} style={styles.backBar}>
      <Ionicons name="chevron-back" size={16} color={colors.green} />
      <Text style={styles.backText}>Retour aux {TAB[nav.params.back]?.label.toLocaleLowerCase("fr") ?? "alertes"}</Text>
    </Pressable> : null}
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
      <DialogHost />
    </SafeAreaView>
  </SafeAreaProvider></DisplayProvider>;
}

// Sign out from anywhere (top bar), after a confirmation.
function confirmSignOut() {
  notify("Se déconnecter", "Voulez-vous vous déconnecter de AgriFresh ?", [
    { text: "Annuler", style: "cancel" },
    { text: "Se déconnecter", style: "destructive", onPress: () => {
      void (async () => {
        await unregisterPush().catch(() => {});
        await supabase?.auth.signOut();
      })();
    } },
  ]);
}

// Messages: larger than the other icons, and pulses (orange) while messages are unread.
function MessagesButton({ selected, unread, onPress }: { selected: boolean; unread: number; onPress: () => void }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!unread) { pulse.setValue(0); return; }
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 650, useNativeDriver: Platform.OS !== "web" }),
      Animated.timing(pulse, { toValue: 0, duration: 650, useNativeDriver: Platform.OS !== "web" }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [unread > 0]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.25, 1] });
  return <Pressable onPress={onPress} style={[styles.messagesButton, selected && styles.tabPillActive]} accessibilityLabel={`Messages${unread ? `, ${unread} non lu(s)` : ""}`} hitSlop={6}>
    {unread ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.messagesGlow, { opacity: glow }]} /> : null}
    <Animated.View style={{ transform: [{ scale }] }}>
      <Ionicons name={selected || unread ? "chatbubbles" : "chatbubbles-outline"} size={28} color={unread ? colors.white : selected ? colors.green : colors.text} />
    </Animated.View>
    {unread > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  messagesButton: { width: 52, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  messagesGlow: { borderRadius: 20, backgroundColor: colors.orange },
  backBar: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: "#f3f8f1", borderBottomWidth: 1, borderBottomColor: colors.line },
  backText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  brand: { color: colors.green, fontSize: 15, fontWeight: "800", letterSpacing: 0.5 },
  topIcon: { width: 40, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  tabBar: { flexDirection: "row", paddingTop: 6, paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  tab: { flex: 1, alignItems: "center", gap: 3, paddingHorizontal: 2 },
  tabPill: { width: 56, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  tabPillActive: { backgroundColor: "#e3eee0" },
  tabLabel: { color: "#8a9187", fontSize: 11, fontWeight: "600" },
  tabActive: { color: colors.green, fontWeight: "800" },
  badge: { position: "absolute", top: -3, right: 4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  badgeText: { color: colors.white, fontSize: 9, fontWeight: "800" },
});
