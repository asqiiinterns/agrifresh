import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import type { Session } from "@supabase/supabase-js";
import { isSupabaseConfigured, supabase } from "./src/lib/supabase";
import { fetchMyAccount, type Account } from "./src/data/account";
import { PermissionsContext } from "./src/data/permissions";
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
import { Button, EmptyState, Loading } from "./src/ui/components";
import { errorMessage, notify } from "./src/ui/notify";
import { colors, ui } from "./src/ui/theme";

type TabKey = "order" | "orders" | "production" | "messages" | "clients" | "invoices" | "deliveries" | "admin" | "account";
type TabDef = { key: TabKey; label: string; icon: string };

const TAB = {
  order: { key: "order", label: "Commander", icon: "＋" },
  orders: { key: "orders", label: "Commandes", icon: "▤" },
  production: { key: "production", label: "Production", icon: "⚙" },
  deliveries: { key: "deliveries", label: "Livraisons", icon: "⇥" },
  clients: { key: "clients", label: "Clients", icon: "☷" },
  invoices: { key: "invoices", label: "Factures", icon: "€" },
  messages: { key: "messages", label: "Messages", icon: "✉" },
  admin: { key: "admin", label: "Admin", icon: "⚒" },
  account: { key: "account", label: "Compte", icon: "◉" },
} satisfies Record<TabKey, TabDef>;

// Tabs follow the features the admin enabled for the account's role.
function tabsFor(account: Account): { kind: "client" | "unlinked" | "team"; tabs: TabDef[] } {
  const has = (feature: string) => account.features.includes(feature);
  if (account.role === "customer") {
    if (!account.client) return { kind: "unlinked", tabs: [TAB.account] };
    return { kind: "client", tabs: [TAB.order, TAB.orders, ...(has("client.invoices") ? [TAB.invoices] : []), ...(has("client.messages") ? [TAB.messages] : []), TAB.account] };
  }
  const tabs: TabDef[] = [];
  if (["orders.decide", "orders.plan", "orders.ship", "claims.manage"].some(has)) tabs.push(TAB.orders);
  if (has("production.view")) tabs.push(TAB.production);
  if (has("deliveries")) tabs.push(TAB.deliveries);
  if (has("clients.view")) tabs.push(TAB.clients);
  if (has("invoices.manage")) tabs.push(TAB.invoices);
  if (has("messages.manage")) tabs.push(TAB.messages);
  if (account.role === "admin") tabs.push(TAB.admin);
  tabs.push(TAB.account);
  return { kind: "team", tabs };
}

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
  const [tab, setTab] = useState<TabKey | null>(null);
  const [ordersKey, setOrdersKey] = useState(0);

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
  const current = tab && tabs.some((item) => item.key === tab) ? tab : tabs[0]?.key;
  const permissions = useMemo(() => new Set(account?.features ?? []), [account]);
  const { unread, refresh: refreshUnread } = useUnreadMessages(tabs.some((item) => item.key === "messages"), kind === "team");

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
      case "order":
        return account.client ? <OrderScreen client={account.client} onPlaced={() => { setOrdersKey((key) => key + 1); setTab("orders"); }} /> : null;
      case "orders":
        return kind === "team" ? <StaffOrdersScreen /> : account.client ? <ClientOrdersScreen key={ordersKey} session={session} client={account.client} /> : null;
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
      case "admin":
        return <AdminScreen />;
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

  return <PermissionsContext.Provider value={permissions}>
    <View style={{ flex: 1 }}>{renderTab()}</View>
    {tabs.length > 1 ? <ScrollView horizontal={tabs.length > 6} scrollEnabled={tabs.length > 6} showsHorizontalScrollIndicator={false} style={styles.tabBarWrap} contentContainerStyle={[styles.tabBar, tabs.length <= 6 && { flex: 1 }]}>
      {tabs.map((item) => {
        const selected = item.key === current;
        return <Pressable key={item.key} onPress={() => setTab(item.key)} style={styles.tab} accessibilityRole="tab" accessibilityState={{ selected }}>
          <View>
            <Text style={[styles.tabIcon, selected && styles.tabActive]}>{item.icon}</Text>
            {item.key === "messages" && unread > 0 ? <View style={styles.badge}><Text style={styles.badgeText}>{unread > 99 ? "99+" : unread}</Text></View> : null}
          </View>
          <Text style={[styles.tabLabel, selected && styles.tabActive]}>{item.label}</Text>
        </Pressable>;
      })}
    </ScrollView> : null}
  </PermissionsContext.Provider>;
}

export default function App() {
  const { session, ready } = useSession();
  useAuthCallback();

  return <SafeAreaProvider>
    <SafeAreaView style={ui.screen} edges={["top", "left", "right", "bottom"]}>
      <StatusBar barStyle="dark-content" backgroundColor={colors.paper} />
      {!isSupabaseConfigured
        ? <EmptyState title="Configuration manquante" body="Renseignez EXPO_PUBLIC_SUPABASE_URL et EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY." />
        : !ready ? <Loading />
        : session ? <Main session={session} />
        : <AuthScreen />}
      <DocumentViewerHost />
    </SafeAreaView>
  </SafeAreaProvider>;
}

const styles = StyleSheet.create({
  tabBarWrap: { flexGrow: 0, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: colors.paper },
  tabBar: { flexDirection: "row", paddingTop: 6, paddingBottom: 4 },
  tab: { flex: 1, minWidth: 64, alignItems: "center", gap: 2, paddingVertical: 4, paddingHorizontal: 4 },
  tabIcon: { color: "#92998f", fontSize: 20, lineHeight: 24, textAlign: "center" },
  tabLabel: { color: "#92998f", fontSize: 10, fontWeight: "600" },
  tabActive: { color: colors.green, fontWeight: "800" },
  badge: { position: "absolute", top: -4, right: -12, minWidth: 18, height: 18, borderRadius: 9, backgroundColor: colors.orange, alignItems: "center", justifyContent: "center", paddingHorizontal: 4 },
  badgeText: { color: colors.white, fontSize: 9, fontWeight: "800" },
});
