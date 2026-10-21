import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text, TextInput } from "./Text";
import { supabase } from "../lib/supabase";
import { allowedFor, homeShortcuts, homeTiles, type HomeShortcutDef } from "./homeCatalog";
import { useNav, type NavParams, type TabKey } from "./navigation";
import { tr } from "./i18n";
import { colors, ui } from "./theme";
import type { Feature } from "../data/permissions";
import type { ModuleKey } from "../data/modules";

// Home search: every function, setting page and shortcut the account may open, and for the team the orders
// (by number or client) and the client records. One tap opens the right screen.
type Entry = { key: string; label: string; icon: HomeShortcutDef["icon"]; tab: TabKey; params?: NavParams; keywords?: string; need: HomeShortcutDef["need"]; module?: ModuleKey; audience: "team" | "customer" | "all" };
type Found = { key: string; label: string; detail?: string; icon: HomeShortcutDef["icon"]; tab: TabKey; params?: NavParams };

// Pages that are not shortcuts: settings, administration and the account's own pages.
const pages: Entry[] = [
  { key: "p_roles", label: "Rôles et accès", keywords: "droits permissions matrice délégation équipe", icon: "key-outline", audience: "team", need: "admin", tab: "admin", params: { page: "roles" } },
  { key: "p_invitations", label: "Invitations", keywords: "inviter code lien qui a invité", icon: "mail-open-outline", audience: "team", need: "admin", tab: "admin", params: { page: "invitations" } },
  { key: "p_alerts", label: "Notifications et e-mails (réglages)", keywords: "alertes push email événements", icon: "notifications-outline", audience: "team", need: "admin", tab: "admin", params: { page: "alerts" } },
  { key: "p_modules", label: "Modules", keywords: "fonctions activer masquer formule", icon: "apps-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "modules" } },
  { key: "p_company", label: "Entreprise", keywords: "raison sociale adresse matricule fiscal rib couleur logo documents", icon: "business-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "company" } },
  { key: "p_numbering", label: "Numérotation des documents", keywords: "numéro bon de livraison facture avoir retour format", icon: "barcode-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "numbering" } },
  { key: "p_workflow", label: "Étapes de production", keywords: "préparation préparée coches étapes découpe emballage contrôle parcours commande", icon: "git-commit-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "workflow" } },
  { key: "p_autodeliver", label: "Clôture automatique des livraisons", keywords: "livrée automatiquement heures délai", icon: "checkmark-done-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "autoDeliver" } },
  { key: "p_clientoptions", label: "Options des clients", keywords: "prix origine stock qr signature acceptation automatique bon de livraison rappels", icon: "storefront-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "clientOptions" } },
  { key: "p_homeprofile", label: "Accueil par profil", keywords: "tableau de bord chiffres raccourcis rôle", icon: "home-outline", audience: "team", need: "admin", tab: "admin", params: { page: "settings", section: "home" } },
  { key: "p_products", label: "Produits", keywords: "catalogue prix tva stock nouveautés origine article", icon: "pricetags-outline", audience: "team", need: "products.manage", tab: "admin", params: { page: "products" } },
  { key: "p_pricing", label: "Remises et tarifs", keywords: "promotion prix négocié groupe de clients", icon: "pricetag-outline", audience: "team", need: "products.manage", module: "pricing", tab: "admin", params: { page: "pricing" } },
  { key: "p_network", label: "Réseau et annuaire", keywords: "relations fournisseurs clients pros mise en relation messages hors réseau", icon: "git-network-outline", audience: "all", need: null, tab: "network" },
  { key: "p_notifications", label: "Notifications reçues", keywords: "alertes", icon: "notifications-outline", audience: "all", need: null, tab: "alerts" },
  { key: "p_profile", label: "Mon profil et mot de passe", keywords: "nom téléphone mot de passe compte informations", icon: "person-circle-outline", audience: "all", need: null, tab: "account", params: { section: "profile" } },
  { key: "p_mynotifs", label: "Mes notifications (téléphone et e-mail)", keywords: "alertes push", icon: "notifications-circle-outline", audience: "all", need: null, tab: "account", params: { section: "notifications" } },
  { key: "p_display", label: "Affichage et langue", keywords: "taille du texte langue anglais arabe", icon: "text-outline", audience: "all", need: null, tab: "account", params: { section: "display" } },
  { key: "p_phone", label: "Autorisations du téléphone", keywords: "appareil photo micro position localisation", icon: "shield-checkmark-outline", audience: "all", need: null, tab: "account", params: { section: "permissions" } },
];

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase("fr");
const matches = (needle: string, ...texts: (string | undefined)[]) => {
  const hay = fold(texts.filter(Boolean).flatMap((text) => [text as string, tr(text as string)]).join(" "));
  return needle.split(/\s+/).filter(Boolean).every((word) => hay.includes(word));
};

export function HomeSearch({ audience, can, isAdmin, moduleOn }: {
  audience: "team" | "customer";
  can: (feature: Feature) => boolean;
  isAdmin: boolean;
  moduleOn: (key: ModuleKey) => boolean;
}) {
  const { navigate } = useNav();
  const [query, setQuery] = useState("");
  const [data, setData] = useState<Found[]>([]);
  const needle = fold(query.trim());

  // Functions: shortcuts, figures and pages this account may open (no duplicate destination).
  const functions = useMemo(() => {
    const all: Entry[] = [
      ...homeShortcuts.map((item) => ({ ...item, audience: item.audience as Entry["audience"] })),
      ...homeTiles.map((tile) => ({ key: tile.key, label: tile.label, icon: tile.icon, tab: tile.tab, params: tile.params, need: tile.need, module: tile.module, audience: tile.audience as Entry["audience"] })),
      ...pages,
    ];
    return all.filter((item) => (item.audience === "all" || item.audience === audience) && allowedFor(item, can, isAdmin, moduleOn));
  }, [audience, can, isAdmin, moduleOn]);

  const found = needle ? functions.filter((item) => matches(needle, item.label, item.keywords)).slice(0, 8) : [];

  // Team: orders (number or client) and client records, from the server, after a short pause.
  useEffect(() => {
    const client = supabase;
    if (!client || audience !== "team" || needle.length < 2) { setData([]); return; }
    const text = query.trim().replace(/[%_,()]/g, " ").trim();
    const number = /^#?\d+$/.test(text) ? Number(text.replace("#", "")) : null;
    let active = true;
    const timer = setTimeout(() => {
      void (async () => {
        const results: Found[] = [];
        if (can("orders.view")) {
          const orders = number !== null
            ? await client.from("orders").select("id, order_number, status, clients(business_name)").eq("order_number", number).limit(5)
            : await client.from("orders").select("id, order_number, status, clients!inner(business_name)").ilike("clients.business_name", `%${text}%`).order("created_at", { ascending: false }).limit(5);
          for (const row of (orders.data ?? []) as unknown as { id: string; order_number: number; status: string; clients: { business_name: string } | null }[]) {
            results.push({ key: `o-${row.id}`, label: `Commande #${row.order_number}`, detail: row.clients?.business_name, icon: "receipt-outline", tab: "orders", params: { orderId: row.id } });
          }
        }
        if (can("clients.view") && number === null) {
          const clients = await client.from("clients").select("id, business_name, client_number").ilike("business_name", `%${text}%`).order("business_name").limit(5);
          for (const row of (clients.data ?? []) as { id: string; business_name: string; client_number: number }[]) {
            results.push({ key: `c-${row.id}`, label: row.business_name, detail: "Fiche client", icon: "storefront-outline", tab: "clients" });
          }
        }
        if (active) setData(results);
      })().catch(() => { if (active) setData([]); });
    }, 300);
    return () => { active = false; clearTimeout(timer); };
  }, [needle, audience]);

  const open = (item: { tab: TabKey; params?: NavParams }) => { setQuery(""); navigate(item.tab, item.params); };
  const rows: Found[] = [...found.map((item) => ({ key: item.key, label: item.label, icon: item.icon, tab: item.tab, params: item.params })), ...data];

  return <View style={{ marginTop: 10 }}>
    <View style={styles.bar}>
      <Ionicons name="search-outline" size={18} color={colors.muted} />
      <TextInput value={query} onChangeText={setQuery} placeholder={audience === "team" ? "Rechercher une fonction, une commande, un client…" : "Rechercher une fonction, un réglage…"}
        placeholderTextColor={colors.muted} style={styles.input} autoCorrect={false} autoCapitalize="none" clearButtonMode="while-editing" returnKeyType="search"
        onSubmitEditing={() => { if (rows[0]) open(rows[0]); }} />
      {query ? <Pressable onPress={() => setQuery("")} hitSlop={8} accessibilityLabel="Effacer"><Ionicons name="close-circle" size={18} color={colors.muted} /></Pressable> : null}
    </View>
    {needle ? <View style={styles.results}>
      {rows.map((item) => <Pressable key={item.key} onPress={() => open(item)} style={({ pressed }) => [styles.row, pressed && { opacity: 0.7 }]}>
        <Ionicons name={item.icon} size={18} color={colors.primary} />
        <View style={{ flex: 1 }}>
          <Text style={ui.strong} numberOfLines={1}>{item.label}</Text>
          {item.detail ? <Text style={ui.small} numberOfLines={1}>{item.detail}</Text> : null}
        </View>
        <Ionicons name="chevron-forward" size={16} color={colors.muted} />
      </Pressable>)}
      {!rows.length ? <Text style={[ui.small, { padding: 12 }]}>Aucun résultat pour « {query.trim()} ».</Text> : null}
    </View> : null}
  </View>;
}

const styles = StyleSheet.create({
  bar: { flexDirection: "row", alignItems: "center", gap: 8, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 10, paddingHorizontal: 10 },
  input: { flex: 1, paddingVertical: 10, fontSize: 14, color: colors.text },
  results: { marginTop: 6, backgroundColor: colors.white, borderWidth: 1, borderColor: colors.line, borderRadius: 10, overflow: "hidden" },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line },
});
