import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Linking, Modal, Platform, Pressable, ScrollView, StatusBar, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text } from "./src/ui/Text";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./src/lib/supabase";
import { fetchMyAccount, roleLabels, type Account } from "./src/data/account";
import { loadCompanyProfile } from "./src/data/company";
import { confirmSignOut } from "./src/ui/signOut";
import { fetchModules, isModuleOn, ModulesContext, onModulesChanged, type ModuleKey, type ModuleState } from "./src/data/modules";
import { PermissionsContext } from "./src/data/permissions";
import { clearShared, setBuyerMode } from "./src/data/shared";
import { autoDeliverOrders } from "./src/data/staff";
import { loadWorkflow } from "./src/data/workflow";
import { DisplayProvider } from "./src/ui/display";
import { alertTarget, countUnreadAlerts, fetchAlertConversation, markAlertsRead } from "./src/data/alerts";
import { AlertsScreen } from "./src/screens/AlertsScreen";
import { askPushOnce, hasPushToken, onAlertTapped, registerForPush, showLocalAlert, unregisterPush } from "./src/notifications";
import { DecideScreen } from "./src/screens/DecideScreen";
import { decisionCount, fetchDecisionBoard } from "./src/data/decisions";
import { ProductionScreen } from "./src/screens/ProductionScreen";
import { AdminScreen } from "./src/screens/AdminScreen";
import { PlatformTeamScreen, ProsScreen } from "./src/screens/PlatformScreens";
import { PlatformSettingsScreen } from "./src/screens/PlatformAdmin";
import { BrowseCatalogButton, InviteCodeCard, ProPendingCard, RegisterProCard } from "./src/screens/ProSignup";
import { fetchMyPro, fetchMySpaces, onAssistChanged, stopAssist, switchSpace, type MyPro, type Space } from "./src/data/pros";
import { NetworkScreen } from "./src/screens/NetworkScreen";
import { acceptInvitation, expireTrials, fetchMySuppliers, fetchPublicSettings, switchSupplier, type MySupplier } from "./src/data/directory";
import { getPendingInvite, onPendingInvite, setPendingInvite, startInviteCapture } from "./src/data/invite";
import { PublicCatalogScreen } from "./src/screens/PublicCatalogScreen";
import { LocationRequestHost } from "./src/ui/LocationRequestHost";
import { PasswordConfirmHost } from "./src/ui/PasswordConfirm";
import { guardedLeave } from "./src/ui/unsavedGuard";
import { countNeedingReply, countUnread } from "./src/data/messages";
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
import { BuyerMessagesScreen, StaffMessagesScreen } from "./src/screens/MessagesScreen";
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
import { Button, EmptyState, Loading, formatDateTime } from "./src/ui/components";
import { errorMessage, notify } from "./src/ui/notify";
import { colors, ui } from "./src/ui/theme";
import { ErrorBoundary } from "./src/ui/ErrorBoundary";
import { installGlobalErrorReporting, setCurrentScreen } from "./src/data/errors";

const TAB = {
  home: { key: "home", label: "Accueil", icon: "home-outline", description: "Tableau de bord du moment." },
  decide: { key: "decide", label: "À décider", icon: "flag-outline", description: "Tout ce qui est en suspens." },
  order: { key: "order", label: "Commander", icon: "add-circle-outline" },
  staffOrder: { key: "staffOrder", label: "Commander", icon: "add-circle-outline", description: "Saisir une commande pour un client." },
  alerts: { key: "alerts", label: "Notifications", icon: "notifications-outline", description: "Notifications reçues." },
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
  admin: { key: "admin", label: "Admin", icon: "settings-outline", description: "Comptes, droits, produits, notifications." },
  account: { key: "account", label: "Plus", icon: "grid-outline", description: "Rubriques, personnaliser, compte, autorisations." },
  more: { key: "more", label: "Plus", icon: "grid-outline" },
  pros: { key: "pros", label: "Pros", icon: "business-outline", description: "Valider, suspendre ou réactiver les Pros." },
  platformTeam: { key: "platformTeam", label: "Équipe Appro+", icon: "people-circle-outline", description: "Les comptes de la plateforme et leurs rôles." },
  network: { key: "network", label: "Réseau", icon: "git-network-outline", description: "Vos clients et fournisseurs, l’annuaire des Pros validés." },
  discover: { key: "discover", label: "Découvrir", icon: "compass-outline", description: "Les produits des fournisseurs ouverts à tous." },
  platformSettings: { key: "platformSettings", label: "Paramétrage", icon: "options-outline", description: "Comptes, modules, modèles de rôles, notifications et e-mails." },
} satisfies Record<TabKey, TabDef>;

// Bottom bar: at most five entries, the rest goes into "Plus".
const MAX_BAR = 6;
// Messages and alerts have their own icons at the top of the screen, with a badge.
const TOP_KEYS: TabKey[] = ["messages", "alerts"];
// Commandes and Planning live as sheets inside "Production" for the team.
const HUB_KEYS: TabKey[] = ["orders", "planning", "production"];

// Tabs follow the features the admin enabled for the account's role, most used first.
function tabsFor(account: Account, modules: ModuleState = {}, pro: MyPro | null = null): { kind: "client" | "unlinked" | "team" | "platform"; tabs: TabDef[] } {
  // Réseau: any member of an active Pro (clients and suppliers among validated Pros).
  const network = pro?.status === "active" && (pro.is_supplier || pro.is_buyer);
  const on = (key: ModuleKey) => isModuleOn(modules, key);
  const has = (feature: string) => account.features.includes(feature);
  const add = (tabs: TabDef[], tab: TabDef, allowed: boolean) => { if (allowed && !tabs.includes(tab)) tabs.push(tab); };
  // The Appro+ team: its own console, separate from every Pro.
  if (account.role === "platform") return { kind: "platform", tabs: [TAB.pros, TAB.platformSettings, TAB.platformTeam, TAB.alerts, TAB.account] };
  if (account.role === "customer") {
    // Découvrir: the public catalogue, for a buyer's space (also before its first supplier).
    const discover = pro?.status === "active" && pro.is_buyer;
    if (!account.client) return { kind: "unlinked", tabs: [...(discover ? [TAB.discover] : []), ...(network ? [TAB.network] : []), TAB.account] };
    const tabs: TabDef[] = [];
    add(tabs, TAB.home, has("client.home"));
    add(tabs, TAB.order, has("client.order"));
    add(tabs, TAB.orders, has("client.orders"));
    add(tabs, TAB.messages, has("client.messages"));
    add(tabs, TAB.alerts, has("client.alerts"));
    add(tabs, TAB.invoices, has("client.invoices"));
    add(tabs, TAB.recurring, has("client.recurring"));
    add(tabs, TAB.discover, discover);
    add(tabs, TAB.network, network);
    tabs.push(TAB.account);
    return { kind: "client", tabs };
  }
  // Main menu: Accueil, Production (Commandes · Production · Planning), Facturation, Livraisons; the rest in "Plus".
  const tabs: TabDef[] = [];
  add(tabs, TAB.home, has("home.view"));
  add(tabs, TAB.decide, on("decide") && (account.role === "admin" || ["orders.decide", "orders.plan", "claims.manage", "messages.manage", "team.messages", "invoices.manage", "returns.manage", "leave.manage", "incidents.manage"].some(has)));
  add(tabs, TAB.production, has("orders.view") || has("production.view") || has("orders.plan"));
  add(tabs, { ...TAB.invoices, label: "Facturation" }, has("invoices.manage"));
  add(tabs, TAB.deliveries, has("deliveries"));
  add(tabs, TAB.staffOrder, has("orders.create"));
  add(tabs, TAB.returns, has("returns.manage"));
  add(tabs, TAB.calendar, has("calendar.view"));
  add(tabs, TAB.leaves, has("leave.request") || has("leave.manage"));
  add(tabs, TAB.incidents, has("incidents.report") || has("incidents.manage"));
  add(tabs, TAB.stats, has("stats.view"));
  add(tabs, TAB.recurring, has("orders.create") && on("recurring"));
  add(tabs, TAB.messages, has("messages.manage") || has("team.messages"));
  add(tabs, TAB.alerts, has("alerts.view"));
  add(tabs, TAB.network, network);
  // Admin pages (accounts, settings, fleet, log, location): reached from Plus → Rubriques and from shortcuts.
  add(tabs, TAB.admin, account.role === "admin" || ["products.manage", "fleet.manage", "audit.view", "location.view"].some(has));
  tabs.push(TAB.account);
  // What the profile does most comes first in the bottom bar.
  const first: TabKey[] = account.role === "driver" ? ["deliveries"] : account.role === "production" ? ["production"] : [];
  tabs.sort((a, b) => (first.includes(b.key) ? 1 : 0) - (first.includes(a.key) ? 1 : 0));
  return { kind: "team", tabs };
}

// "Compte" closes the bar; the sections that do not fit are listed in Compte → Rubriques.
// preferred: the bottom bar chosen for the person's role (Rôles et accès); the other entries go into « Plus ».
function splitBar(tabs: TabDef[], preferred?: string[] | null): { bar: TabDef[]; overflow: TabDef[] } {
  if (preferred?.length) {
    const pinned = preferred.map((key) => tabs.find((item) => item.key === key && item.key !== "account")).filter((item): item is TabDef => !!item).slice(0, MAX_BAR - 1);
    if (pinned.length) return { bar: [...pinned, tabs.find((item) => item.key === "account") ?? TAB.account], overflow: tabs.filter((item) => !pinned.includes(item) && item.key !== "account") };
  }
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

// Unread client messages plus, for the team, unread messages between colleagues,
// and the messages waiting for my answer (red mark on the icon).
function useUnreadMessages(enabled: boolean, isStaff: boolean, sources: { clients: boolean; team: boolean }) {
  const [unread, setUnread] = useState(0);
  const [needsReply, setNeedsReply] = useState(0);
  const { clients, team } = sources;
  const refresh = useCallback(() => {
    if (!enabled) return;
    void Promise.all([clients ? countUnread(isStaff) : 0, team ? countTeamUnread() : 0]).then(([a, b]) => setUnread(a + b));
    void countNeedingReply().then(setNeedsReply).catch(() => setNeedsReply(0));
  }, [enabled, isStaff, clients, team]);

  useEffect(() => {
    const client = supabase;
    if (!enabled || !client) {
      setUnread(0);
      setNeedsReply(0);
      return;
    }
    refresh();
    const channel = client
      .channel(`unread-${isStaff ? "staff" : "client"}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "messages" }, refresh)
      .on("postgres_changes", { event: "*", schema: "public", table: "team_messages" }, refresh)
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [enabled, isStaff, refresh]);

  return { unread, needsReply, refresh };
}

function Main({ session }: { session: Session }) {
  const [account, setAccount] = useState<Account | null>(null);
  const [accountError, setAccountError] = useState("");
  const { width } = useWindowDimensions();
  const [nav, setNav] = useState<{ tab: TabKey | null; params?: NavParams; nonce: number }>({ tab: null, nonce: 0 });
  const tab = nav.tab;
  const [ordersKey, setOrdersKey] = useState(0);
  // A tile, a shortcut or a menu button opens a tab (at a given section); each call remounts the target
  // screen, so tapping the open tab again reloads it.
  // Leaving a page with changes not saved asks first (see ui/unsavedGuard).
  const navigate = useCallback((next: TabKey, params?: NavParams) => guardedLeave(() => setNav((state) => ({ tab: next, params, nonce: state.nonce + 1 }))), []);
  const setTab = useCallback((next: TabKey | null) => setNav((state) => ({ tab: next, nonce: state.nonce })), []);
  const navValue = useMemo(() => ({ navigate }), [navigate]);

  const [modules, setModules] = useState<ModuleState>({});
  const [myPro, setMyPro] = useState<MyPro | null>(null);
  const [suppliers, setSuppliers] = useState<MySupplier[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [spacePicker, setSpacePicker] = useState(false);
  const spaceAsked = useRef(false);
  const [choosing, setChoosing] = useState(false);
  const loadAccount = useCallback(async () => {
    setAccountError("");
    clearShared();
    // The production steps follow the space (and Appro+ assisting a Pro).
    void loadWorkflow(true).catch(() => undefined);
    try {
      // All in parallel: each request costs a round trip to the server. Trials over are closed in the same wave.
      const [next, nextModules, nextPro, nextSuppliers, nextSpaces] = await Promise.all([fetchMyAccount(), fetchModules(), fetchMyPro(), fetchMySuppliers(), fetchMySpaces(), expireTrials().catch(() => undefined), autoDeliverOrders().catch(() => undefined)]);
      setModules(nextModules);
      setMyPro(nextPro);
      setSuppliers(next.role === "customer" ? nextSuppliers : []);
      setBuyerMode(next.role === "customer");
      setSpaces(nextSpaces);
      // Several spaces: choose one when signing in (once per session).
      if (nextSpaces.length > 1 && !spaceAsked.current) { spaceAsked.current = true; setSpacePicker(true); }
      setAccount(next);
      void loadCompanyProfile().catch(() => undefined);
    } catch (cause) {
      setAccountError(errorMessage(cause, "Impossible de charger votre profil."));
    }
  }, []);

  useEffect(() => {
    setAccount(null);
    setTab(null);
    void loadAccount();
  }, [session.user.id, loadAccount]);
  // A module switched on or off changes the rights: reload both.
  useEffect(() => onModulesChanged(() => { void loadAccount(); }), [loadAccount]);
  // Appro+ starts or ends assisting a Pro: everything follows (menus, rights, space).
  useEffect(() => onAssistChanged(() => { setTab(null); void loadAccount(); }), [loadAccount]);
  // The assistance ends by itself at its time: the console comes back.
  const assistEnds = account?.assisting?.expires_at;
  useEffect(() => {
    if (!assistEnds) return;
    const delay = new Date(assistEnds).getTime() - Date.now() + 1000;
    const timer = setTimeout(() => { setTab(null); void loadAccount(); }, Math.max(1000, Math.min(delay, 12 * 3600 * 1000)));
    return () => clearTimeout(timer);
  }, [assistEnds, loadAccount]);

  // An invitation link opened before signing in (or a code captured since): accepted once signed in.
  useEffect(() => {
    let busy = false;
    const accept = async (code: string | null) => {
      if (!code || busy) return;
      busy = true;
      try {
        const result = await acceptInvitation(code);
        await setPendingInvite(null);
        notify("Invitation", result.linked ? `Bienvenue : vous êtes en relation avec ${result.org_name}.`
          : result.needs_space ? `Invitation de ${result.org_name} : créez votre espace (Plus → Mon compte), la relation se fera aussitôt.`
          : `Invitation de ${result.org_name} enregistrée.`);
        await loadAccount();
      } catch (cause) {
        await setPendingInvite(null);
        notify("Invitation", errorMessage(cause, "L’invitation n’a pas pu être utilisée."));
      } finally {
        busy = false;
      }
    };
    void getPendingInvite().then(accept);
    return onPendingInvite((code) => void accept(code));
  }, [session.user.id, loadAccount]);

  // Trial length set by Appro+, shown to a new account creating its space.
  const [trialHours, setTrialHours] = useState(0);
  const [pendingAccount, setPendingAccount] = useState(false);
  useEffect(() => { void fetchPublicSettings().then((settings) => setTrialHours(settings.trial_hours)); }, []);

  const { kind, tabs } = account ? tabsFor(account, modules, myPro) : { kind: null, tabs: [] as TabDef[] };
  // Every buyer screen covers all its suppliers (20261122): no "selected supplier" pill any more.
  const supplierPill = false;
  const { bar, overflow } = splitBar(tabs.filter((item) => !TOP_KEYS.includes(item.key)), account?.menu?.bar);
  // Commandes / Planning requested by a tile, an alert or a button open the matching sheet of "Production".
  const hub = kind === "team" && tabs.some((item) => item.key === "production");
  // Former "Plus" and client records now live in Compte.
  const accountSheet = tab === "more" ? "sections" : tab === "clients" ? "clients" : tab === "account" ? nav.params?.section : undefined;
  const requested = hub && tab && HUB_KEYS.includes(tab) ? "production" : tab === "more" || tab === "clients" ? "account" : tab;
  const hubSheet: HubSheet | undefined = tab === "orders" ? "orders" : tab === "planning" ? "planning"
    : nav.params?.section === "prepare" || nav.params?.section === "planning" || nav.params?.section === "orders" ? nav.params.section as HubSheet : undefined;
  const current = requested && tabs.some((item) => item.key === requested) ? requested : bar[0]?.key ?? tabs[0]?.key;
  setCurrentScreen(current ?? null);
  // A shortcut or alert pointing to a section this account cannot open says so instead of silently showing the home screen.
  const unavailable = !!account && !!requested && requested !== current;
  const barCurrent = overflow.some((item) => item.key === current) ? "account" : current;
  const permissions = useMemo(() => new Set(account?.features ?? []), [account]);
  const { unread, needsReply, refresh: refreshUnread } = useUnreadMessages(tabs.some((item) => item.key === "messages"), kind === "team", {
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
        const target = alertTarget(data.event, data.order_id, account?.role !== "customer", conversationId, account?.role === "platform");
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
      pending: { title: "Compte en attente de validation", body: "Votre compte est créé. L’administrateur doit le valider avant que vous puissiez l’utiliser ; touchez « Actualiser » une fois prévenu." },
      refused: { title: "Demande refusée", body: "L’administrateur n’a pas validé ce compte. Contactez-le si vous pensez qu’il s’agit d’une erreur." },
      suspended: { title: "Compte suspendu", body: "Votre accès est suspendu. Contactez l’administrateur pour le réactiver." },
    }[status];
    // A free sign-up (no space, no client record) creates its space (business or private person); a space
    // waiting for Appro+ says so. Both can browse the suppliers' public products and use an invitation code.
    const free = !myPro && !account.client && account.role !== "platform";
    const reason = myPro?.status === "suspended" && myPro.trial_until ? "Votre période d’essai est terminée : vous pourrez commander dès que l’équipe Appro+ aura validé votre espace."
      : free ? "Créez votre espace (entreprise ou particulier) pour commander."
      : "Vous pourrez commander dès que votre compte sera validé.";
    return <View style={{ flex: 1 }}>
      <View style={styles.topBar}>
        <Text style={styles.brand}>Appro<Text style={styles.brandPlus}>+</Text></Text>
        <View style={{ flex: 1 }} />
        <Pressable onPress={confirmSignOut} style={styles.topIcon} accessibilityLabel="Se déconnecter" hitSlop={6}>
          <Ionicons name="log-out-outline" size={22} color={colors.danger} />
        </Pressable>
        <Pressable onPress={() => setPendingAccount(true)} style={styles.me} accessibilityLabel="Mon compte" hitSlop={4}>
          <View style={styles.meAvatar}><Ionicons name="person" size={14} color={colors.white} /></View>
          <Text style={[styles.meName, { maxWidth: width < 400 ? 110 : 200 }]} numberOfLines={1}>{account.full_name || session.user.email}</Text>
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: 30 }} keyboardShouldPersistTaps="handled">
      <EmptyState title={myPro ? "Espace en attente" : message.title} body={myPro ? "" : free ? "Votre compte est créé. Créez votre espace ci-dessous : entreprise (fournisseur, acheteur) ou particulier." : message.body}
        action={<Button label="ACTUALISER" variant="secondary" onPress={() => loadAccount()} />} />
      <View style={{ paddingHorizontal: 14, gap: 10 }}>
        {myPro ? <ProPendingCard pro={myPro} /> : free && status === "pending" ? <RegisterProCard trialHours={trialHours} onDone={() => void loadAccount()} /> : null}
        {status !== "refused" ? <BrowseCatalogButton reason={reason} /> : null}
        {account.role !== "platform" ? <InviteCodeCard onDone={() => void loadAccount()} /> : null}
        <Button label="MON COMPTE (MOT DE PASSE, LANGUE…)" variant="secondary" onPress={() => setPendingAccount(true)} />
      </View>
      </ScrollView>
      <Modal visible={pendingAccount} animationType="slide" onRequestClose={() => setPendingAccount(false)}>
        <SafeAreaView style={ui.modalSafe}>
          <View style={[styles.topBar, { justifyContent: "flex-end" }]}>
            <Button label="FERMER" variant="secondary" onPress={() => setPendingAccount(false)} />
          </View>
          <AccountScreen session={session} account={account} />
        </SafeAreaView>
      </Modal>
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
        return kind === "team" ? <StaffOrdersScreen initialSection={nav.params?.section} initialOrderId={nav.params?.orderId} /> : account.client ? <ClientOrdersScreen key={ordersKey} session={session} client={account.client} initialOrderId={nav.params?.orderId}
          onOpenSupplier={(clientId, orderId) => void switchSupplier(clientId).then(() => loadAccount()).then(() => navigate("orders", { orderId })).catch((cause: unknown) => notify("Fournisseur", errorMessage(cause, "Impossible de changer de fournisseur.")))} /> : null;
      case "messages":
        return kind === "team" ? <StaffMessagesScreen moderator={["admin", "supervisor", "staff"].includes(account.role)} canClients={account.features.includes("messages.manage")} canTeam={account.features.includes("team.messages")} initialSection={nav.params?.section} initialConversationId={nav.params?.page} onRead={refreshUnread} /> : account.client ? <BuyerMessagesScreen clientId={account.client.id} onRead={refreshUnread} /> : null;
      case "production":
        return kind === "team" ? <ProductionHub initialSheet={hubSheet} ordersSection={tab === "orders" ? nav.params?.section : undefined} orderId={nav.params?.orderId} /> : null;
      case "invoices":
        return kind === "team" ? <StaffInvoicesScreen /> : <ClientInvoicesScreen initialSheet={nav.params?.section} onSheet={(section) => setNav((state) => ({ ...state, params: { ...state.params, section } }))} />;
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
        return <DriverScreen initialSection={nav.params?.section} />;
      case "alerts":
        return <AlertsScreen userId={session.user.id} team={kind === "team"} platform={kind === "platform"} onRead={alerts.refresh} />;
      case "pros":
        return <ProsScreen />;
      case "platformTeam":
        return <PlatformTeamScreen />;
      case "platformSettings":
        return <PlatformSettingsScreen initialPage={nav.params?.page} />;
      case "network":
        return <NetworkScreen initialSection={nav.params?.section} onChanged={() => void loadAccount()} />;
      case "discover":
        return <PublicCatalogScreen canOrder={account.role === "customer" && myPro?.status === "active"}
          reason={account.role !== "customer" ? "Passez dans votre espace Acheteur pour commander." : "Votre espace doit être actif pour commander."}
          onOrdered={() => void loadAccount()} />;
      case "admin":
        return <AdminScreen isAdmin={account.role === "admin"} initialPage={nav.params?.page} initialSection={nav.params?.section} />;
      default:
        return <View style={{ flex: 1 }}>
          {kind === "unlinked" ? <View style={[ui.card, { marginHorizontal: 18, marginTop: 18 }]}>
            <Text style={ui.strong}>Compte non rattaché</Text>
            <Text style={[ui.body, { marginTop: 6 }]}>Aucune fiche client active ne correspond à {session.user.email}. Demandez à votre fournisseur de créer ou d’activer votre fiche avec cette adresse, puis touchez « Actualiser ».</Text>
            <Button label="ACTUALISER" variant="secondary" onPress={() => loadAccount()} style={{ marginTop: 12 }} />
          </View> : null}
          <AccountScreen session={session} account={account} sections={overflow} initialSheet={accountSheet} onLayoutChanged={() => void loadAccount()} />
        </View>;
    }
  }

  const badgeFor = (key: TabKey) => key === "messages" ? unread : key === "alerts" ? alerts.unread : key === "decide" ? decideCount : 0;
  const topTabs = tabs.filter((item) => TOP_KEYS.includes(item.key));
  const currentSpace = spaces.find((item) => item.current);
  const who = (() => {
    const name = account.full_name?.trim() || session.user.email || "Mon compte";
    const words = name.split(/[\s@.]+/).filter(Boolean);
    const initials = ((words[0]?.[0] ?? "") + (words[1]?.[0] ?? "")).toUpperCase() || "?";
    const detail = currentSpace ? `${currentSpace.org_name} · ${currentSpace.mode === "buyer" ? "Acheteur" : "Fournisseur"}`
      : account.client?.business_name ?? myPro?.name ?? roleLabels[account.role];
    return { name, initials, detail };
  })();

  return <ModulesContext.Provider value={modules}><PermissionsContext.Provider value={permissions}><NavContext.Provider value={navValue}>
    {/* A colleague asks where I am: I accept or refuse (team accounts, Localisation module on). */}
    <LocationRequestHost enabled={isActive && account.role !== "customer" && account.role !== "platform" && isModuleOn(modules, "location")} />
    <View style={styles.topBar}>
      <Text style={styles.brand}>Appro<Text style={styles.brandPlus}>+</Text></Text>
      <View style={{ flex: 1 }} />
      {topTabs.map((item) => {
        const selected = item.key === current;
        const badge = badgeFor(item.key);
        if (item.key === "messages") return <MessagesButton key={item.key} selected={selected} unread={badge} needsReply={isModuleOn(modules, "needs_reply") ? needsReply : 0} onPress={() => navigate(item.key)} />;
        return <Pressable key={item.key} onPress={() => navigate(item.key)} style={[styles.topIcon, selected && styles.tabPillActive]} accessibilityLabel={`${item.label}${badge ? `, ${badge} non lu(s)` : ""}`} hitSlop={6}>
          <Ionicons name={selected ? filledIcon(item.icon) : item.icon} size={22} color={selected ? colors.primary : colors.text} />
          {badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text></View> : null}
        </Pressable>;
      })}
      <Pressable onPress={confirmSignOut} style={styles.topIcon} accessibilityLabel="Se déconnecter" hitSlop={6}>
        <Ionicons name="log-out-outline" size={22} color={colors.danger} />
      </Pressable>
      {/* Who is signed in, always visible: name, then the space (Pro · side) or the role. */}
      <Pressable onPress={() => navigate("account")} style={styles.me} accessibilityLabel={`Compte connecté : ${who.name}`} hitSlop={4}>
        <View style={styles.meAvatar}><Text style={styles.meInitials}>{who.initials}</Text></View>
        <View style={{ maxWidth: width < 400 ? 84 : 150 }}>
          <Text style={styles.meName} numberOfLines={1}>{who.name}</Text>
          {who.detail ? <Text style={styles.meDetail} numberOfLines={1}>{who.detail}</Text> : null}
        </View>
      </Pressable>
    </View>
    {/* One pill: the space (when there are several) and, only on the screens that still work with one supplier
        at a time (credit notes, returns, recurring orders), the selected supplier. Everything else covers all suppliers. */}
    {spaces.length > 1 || supplierPill ? <Pressable onPress={() => spaces.length > 1 ? setSpacePicker(true) : setChoosing(true)} style={styles.supplierBar}>
      <Ionicons name={spaces.find((item) => item.current)?.mode === "buyer" || spaces.length <= 1 ? "cart-outline" : "business-outline"} size={16} color={colors.primary} />
      <Text style={styles.supplierText} numberOfLines={1}>{[
        spaces.length > 1 ? (() => { const space = spaces.find((item) => item.current); return space ? `${space.org_name} · ${space.mode === "buyer" ? "Acheteur" : "Fournisseur"}` : "Choisir un espace"; })() : null,
        supplierPill ? `chez ${suppliers.find((item) => item.current)?.name ?? "à choisir"}` : null,
      ].filter(Boolean).join(" · ")}</Text>
      <Ionicons name="chevron-down" size={16} color={colors.primary} />
    </Pressable> : null}
    <Modal visible={spacePicker} transparent animationType="fade" onRequestClose={() => setSpacePicker(false)}>
      <Pressable style={styles.chooserBackdrop} onPress={() => setSpacePicker(false)}>
        <View style={styles.chooser}>
          <Text style={ui.strong}>Dans quel espace travaillez-vous ?</Text>
          <Text style={ui.small}>Les menus, les droits et les données suivent l’espace choisi. Vous pouvez en changer à tout moment en haut de l’écran.</Text>
          {spaces.map((item) => <Pressable key={`${item.org_id}-${item.mode}`} style={[styles.chooserRow, item.current && { backgroundColor: colors.primarySoft }]}
            onPress={() => { setSpacePicker(false); if (item.current) return; void switchSpace(item.org_id, item.mode).then(() => { setTab(null); return loadAccount(); }).catch((cause: unknown) => notify("Espace", errorMessage(cause, "Impossible de changer d’espace."))); }}>
            <Ionicons name={item.mode === "buyer" ? "cart-outline" : "business-outline"} size={18} color={colors.primary} />
            <View style={{ flex: 1 }}>
              <Text style={ui.body}>{item.org_name}</Text>
              <Text style={ui.small}>{item.mode === "buyer" ? "Acheteur : commander à ses fournisseurs" : "Fournisseur : vendre, préparer, livrer, facturer"}</Text>
            </View>
            {item.current ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
          </Pressable>)}
          {supplierPill ? <Pressable style={[styles.chooserRow, { borderTopWidth: 1, borderTopColor: colors.line }]} onPress={() => { setSpacePicker(false); setChoosing(true); }}>
            <Ionicons name="storefront-outline" size={18} color={colors.primary} />
            <Text style={[ui.body, { flex: 1 }]}>{`Fournisseur pour cet écran : ${suppliers.find((item) => item.current)?.name ?? "à choisir"}`}</Text>
            <Ionicons name="chevron-forward" size={18} color={colors.primary} />
          </Pressable> : null}
        </View>
      </Pressable>
    </Modal>
    <Modal visible={choosing} transparent animationType="fade" onRequestClose={() => setChoosing(false)}>
      <Pressable style={styles.chooserBackdrop} onPress={() => setChoosing(false)}>
        <View style={styles.chooser}>
          <Text style={ui.strong}>Choisir le fournisseur</Text>
          <Text style={ui.small}>Pour les avoirs, les retours et les commandes récurrentes. Commander, Commandes, Factures et Messages couvrent tous vos fournisseurs.</Text>
          {suppliers.map((item) => <Pressable key={item.client_id} style={[styles.chooserRow, item.current && { backgroundColor: colors.primarySoft }]}
            onPress={() => { setChoosing(false); void switchSupplier(item.client_id).then(() => { setTab(null); return loadAccount(); }).catch((cause: unknown) => notify("Fournisseur", errorMessage(cause, "Impossible de changer de fournisseur."))); }}>
            <Text style={[ui.body, { flex: 1 }]}>{item.name}</Text>
            {item.current ? <Ionicons name="checkmark" size={18} color={colors.primary} /> : null}
          </Pressable>)}
        </View>
      </Pressable>
    </Modal>
    {/* Appro+ assisting this Pro: always visible, with the way out. */}
    {account.assisting ? <View style={styles.assistBar}>
      <Ionicons name="headset-outline" size={16} color={colors.white} />
      <Text style={styles.assistText} numberOfLines={2}>Vous assistez {account.assisting.org_name} · {account.assisting.can_edit ? "lecture et modification" : "lecture seule"} · jusqu’à {new Date(account.assisting.expires_at).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</Text>
      <Pressable onPress={() => void stopAssist().then(() => { setTab(null); return loadAccount(); }).catch((cause: unknown) => notify("Assistance", errorMessage(cause, "L’assistance n’a pas pu être terminée.")))} style={styles.assistStop} hitSlop={6}>
        <Text style={styles.assistStopText}>TERMINER</Text>
      </Pressable>
    </View> : null}
    {myPro?.status === "active" && myPro.trial_until ? <View style={styles.unavailable}>
      <Ionicons name="time-outline" size={16} color={colors.amber} />
      <Text style={styles.unavailableText}>Espace en essai jusqu’au {formatDateTime(myPro.trial_until)} : il reste actif dès que l’équipe Appro+ l’a validé.</Text>
    </View> : null}
    {nav.params?.back && nav.params.back !== current ? <Pressable onPress={() => setTab(nav.params!.back!)} style={styles.backBar}>
      <Ionicons name="chevron-back" size={16} color={colors.primary} />
      <Text style={styles.backText}>Retour aux {TAB[nav.params.back]?.label.toLocaleLowerCase("fr") ?? "notifications"}</Text>
    </Pressable> : null}
    {unavailable ? <Pressable onPress={() => setTab(null)} style={styles.unavailable}>
      <Ionicons name="information-circle-outline" size={16} color={colors.amber} />
      <Text style={styles.unavailableText}>Cette rubrique n’est pas disponible pour votre compte (droit ou module désactivé).</Text>
      <Ionicons name="close" size={16} color={colors.muted} />
    </Pressable> : null}
    {/* A screen that crashes shows a card (and is reported to Appro+), never a white page. */}
    <View key={`${current}-${nav.nonce}`} style={{ flex: 1 }}><ErrorBoundary screen={String(current ?? "accueil")} onHome={() => setTab(null)}>{renderTab()}</ErrorBoundary></View>
    {bar.length > 1 ? <View style={styles.tabBar}>
      {bar.map((item) => {
        const selected = item.key === barCurrent;
        const badge = badgeFor(item.key);
        return <Pressable key={item.key} onPress={() => navigate(item.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected }} accessibilityLabel={item.label}>
          <View style={[styles.tabPill, selected && styles.tabPillActive]}>
            <Ionicons name={selected ? filledIcon(item.icon) : item.icon} size={22} color={selected ? colors.primary : colors.muted} />
            {badge > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{badge > 99 ? "99+" : badge}</Text></View> : null}
          </View>
          <Text style={[styles.tabLabel, selected && styles.tabActive]} numberOfLines={1}>{item.label}</Text>
        </Pressable>;
      })}
    </View> : null}
  </NavContext.Provider></PermissionsContext.Provider></ModulesContext.Provider>;
}

export default function App() {
  const { session, ready } = useSession();
  useAuthCallback();
  // An invitation link (…/?invite=CODE) is kept until the person has signed in.
  useEffect(() => startInviteCapture(), []);
  useEffect(() => installGlobalErrorReporting(), []);

  return <DisplayProvider><SafeAreaProvider>
    <SafeAreaView style={ui.screen} edges={["top", "left", "right", "bottom"]}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.paper} />
      {!isSupabaseConfigured
        ? <EmptyState title="Configuration manquante" body="Renseignez EXPO_PUBLIC_SUPABASE_URL et EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY." />
        : !ready ? <Loading />
        : session ? <ErrorBoundary screen="application"><Main session={session} /></ErrorBoundary>
        : <AuthScreen />}
      <DocumentViewerHost />
      <DialogHost />
      <PasswordConfirmHost />
    </SafeAreaView>
  </SafeAreaProvider></DisplayProvider>;
}


// Messages: larger than the other icons, pulses (orange) while messages are unread,
// and wears a red ring with "!" while a message waits for my answer.
function MessagesButton({ selected, unread, needsReply, onPress }: { selected: boolean; unread: number; needsReply: number; onPress: () => void }) {
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
  return <Pressable onPress={onPress} style={[styles.messagesButton, selected && styles.tabPillActive, needsReply > 0 && styles.messagesWaiting]} accessibilityLabel={`Messages${unread ? `, ${unread} non lu(s)` : ""}${needsReply ? `, ${needsReply} réponse(s) attendue(s)` : ""}`} hitSlop={6}>
    {unread ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.messagesGlow, { opacity: glow }]} /> : null}
    <Animated.View style={{ transform: [{ scale }] }}>
      <Ionicons name={selected || unread || needsReply ? "chatbubbles" : "chatbubbles-outline"} size={28} color={unread ? colors.white : needsReply ? colors.danger : selected ? colors.primary : colors.text} />
    </Animated.View>
    {needsReply > 0 ? <View style={styles.replyMark}><Text style={styles.replyMarkText}>!</Text></View> : null}
    {unread > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
  </Pressable>;
}

const styles = StyleSheet.create({
  supplierBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: colors.primarySoft, borderBottomWidth: 1, borderBottomColor: colors.line },
  supplierText: { flex: 1, color: colors.primary, fontSize: 12, fontWeight: "800" },
  chooserBackdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.35)", justifyContent: "center", padding: 24 },
  chooser: { backgroundColor: colors.white, borderRadius: 12, padding: 14, gap: 6 },
  chooserRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 10, paddingVertical: 10, borderRadius: 8, borderWidth: 1, borderColor: colors.line },
  unavailable: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: "#fffbef", borderBottomWidth: 1, borderBottomColor: "#e3c46f" },
  unavailableText: { flex: 1, color: colors.text, fontSize: 12 },
  messagesButton: { width: 52, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  messagesGlow: { borderRadius: 20, backgroundColor: colors.orange },
  messagesWaiting: { borderWidth: 2, borderColor: colors.danger },
  replyMark: { position: "absolute", top: -4, left: -2, width: 17, height: 17, borderRadius: 9, backgroundColor: colors.danger, alignItems: "center", justifyContent: "center", borderWidth: 1.5, borderColor: colors.white },
  replyMarkText: { color: colors.white, fontSize: 11, fontWeight: "900", lineHeight: 13 },
  backBar: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: colors.primarySoft, borderBottomWidth: 1, borderBottomColor: colors.line },
  backText: { color: colors.primary, fontSize: 12, fontWeight: "800" },
  topBar: { flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 14, paddingVertical: 4, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
  brand: { color: colors.primary, fontSize: 17, fontWeight: "800", letterSpacing: 0.3 },
  brandPlus: { color: colors.accent, fontWeight: "900" },
  topIcon: { width: 40, height: 34, borderRadius: 17, alignItems: "center", justifyContent: "center" },
  assistBar: { flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 14, paddingVertical: 7, backgroundColor: "#7a2e8a" },
  assistText: { flex: 1, color: colors.white, fontSize: 12, fontWeight: "800" },
  assistStop: { borderWidth: 1, borderColor: colors.white, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  assistStopText: { color: colors.white, fontSize: 11, fontWeight: "800" },
  me: { flexDirection: "row", alignItems: "center", gap: 6, paddingLeft: 4, paddingRight: 8, paddingVertical: 3, borderRadius: 18, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  meAvatar: { width: 28, height: 28, borderRadius: 14, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  meInitials: { color: colors.white, fontSize: 12, fontWeight: "800" },
  meName: { color: colors.text, fontSize: 12, fontWeight: "800" },
  meDetail: { color: colors.muted, fontSize: 10, fontWeight: "600" },
  tabBar: { flexDirection: "row", paddingTop: 6, paddingBottom: 6, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.white },
  tab: { flex: 1, alignItems: "center", gap: 3, paddingHorizontal: 2 },
  tabPill: { width: 56, height: 30, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  tabPillActive: { backgroundColor: colors.primarySoft },
  tabLabel: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  tabActive: { color: colors.primary, fontWeight: "800" },
  badge: { position: "absolute", top: -3, right: 4, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  badgeText: { color: colors.white, fontSize: 9, fontWeight: "800" },
});
