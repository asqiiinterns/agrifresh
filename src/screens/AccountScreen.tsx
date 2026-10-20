import { useState } from "react";
import { ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { formatClientNumber, roleLabels, type Account } from "../data/account";
import { Button, Chip, Field, ListGroup, ListRow, ScreenHeader, Sheets } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { ui } from "../ui/theme";
import { StaffProductsModal } from "./StaffProductsScreen";
import { useCan } from "../data/permissions";
import { MyNotificationsCard } from "./NotificationSettings";
import { unregisterPush } from "../notifications";
import { fontScales, useDisplay } from "../ui/display";
import { languages } from "../ui/i18n";
import { useNav, type TabDef } from "../ui/navigation";
import { HomeCustomizeCard } from "./HomeScreen";
import { StaffClientsScreen } from "./StaffClientsScreen";
import { PermissionsCard } from "./PermissionsCard";
import { Switch } from "react-native";
import { colors } from "../ui/theme";
import { useModules } from "../data/modules";

export type AccountSheet = "sections" | "profile" | "home" | "display" | "password" | "products" | "clients" | "notifications" | "permissions";

// "Compte": the other sections of the app (former "Plus") and every personal setting, as sheets.
export function AccountScreen({ session, account, sections = [], initialSheet, onLayoutChanged }: {
  session: Session;
  account: Account | null;
  sections?: TabDef[];
  initialSheet?: string;
  onLayoutChanged?: () => void;
}) {
  const can = useCan();
  const mod = useModules();
  const { navigate } = useNav();
  const active = !!account && (account.status ?? "active") === "active";
  const hasHome = active && (account?.role === "customer" ? can("client.home") : can("home.view"));
  const isAdmin = account?.role === "admin";
  const adminPages = !sections.some((item) => item.key === "admin") ? [] : [
    { page: "accounts", icon: "person-outline", title: "Comptes", detail: "Validation des inscriptions, suspension, rôle, ajout d’un compte.", allowed: isAdmin },
    { page: "settings", icon: "options-outline", title: "Paramétrage", detail: "Modules, droits par profil, options des clients, entreprise, numérotation, accueil.", allowed: isAdmin },
    { page: "alerts", icon: "notifications-outline", title: "Alertes et e-mails", detail: "Événements notifiés et service d’envoi.", allowed: isAdmin },
    { page: "fleet", icon: "car-outline", title: "Flotte", detail: "Véhicules proposés au livreur à l’expédition.", allowed: can("fleet.manage") },
    { page: "audit", icon: "time-outline", title: "Journal des actions", detail: "Qui a fait quoi et quand, sur tout le système.", allowed: can("audit.view") },
    { page: "location", icon: "location-outline", title: "Localisation", detail: "Dernière position des comptes qui la partagent.", allowed: can("location.view") },
  ].filter((page) => page.allowed) as { page: string; icon: TabDef["icon"]; title: string; detail: string }[];
  const sheets: { key: AccountSheet; label: string }[] = [
    ...(sections.length ? [{ key: "sections" as const, label: "Rubriques" }] : []),
    ...(hasHome && mod("home_custom") ? [{ key: "home" as const, label: "Personnaliser" }] : []),
    { key: "profile", label: "Compte" },
    { key: "display", label: "Affichage" },
    ...(active ? [{ key: "notifications" as const, label: "Notifications" }] : []),
    { key: "permissions", label: "Autorisations" },
    ...(active && can("products.manage") ? [{ key: "products" as const, label: "Produits" }] : []),
    ...(active && can("clients.view") ? [{ key: "clients" as const, label: "Clients" }] : []),
  ];
  const [sheet, setSheet] = useState<AccountSheet>(sheets.some((item) => item.key === initialSheet) ? initialSheet as AccountSheet : sheets[0].key);

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={session.user.email?.toLocaleUpperCase("fr") ?? "VOTRE ESPACE"} title="Plus" />
    <Sheets items={sheets} value={sheet} onChange={setSheet} />
    {sheet === "clients" ? <StaffClientsScreen embedded /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      {sheet === "sections" ? <>
        {sections.some((item) => item.key !== "admin") ? <ListGroup title="Rubriques">
          {sections.filter((item) => item.key !== "admin").map((item) => <ListRow key={item.key} icon={item.icon} title={item.label} detail={item.description} onPress={() => navigate(item.key)} />)}
        </ListGroup> : null}
        {/* Admin pages listed one by one, so none is reachable only through a home shortcut. */}
        {adminPages.length ? <ListGroup title="Administration">
          {adminPages.map((page) => <ListRow key={page.page} icon={page.icon} title={page.title} detail={page.detail} onPress={() => navigate("admin", { page: page.page })} />)}
        </ListGroup> : null}
      </> : null}
      {sheet === "profile" ? <><ProfileCard session={session} account={account} /><PasswordCard /></> : null}
      {sheet === "permissions" ? <PermissionsCard /> : null}
      {sheet === "home" && account ? <HomeCustomizeCard account={account} onLayoutChanged={onLayoutChanged ?? (() => {})} /> : null}
      {sheet === "display" ? <DisplaySettingsCard showProducts={account?.role === "customer"} /> : null}
      {sheet === "products" ? <ProductsCard /> : null}
      {sheet === "notifications" ? <><MyNotificationsCard />{account?.client && mod("reminders") ? <ReminderChoiceCard account={account} onChanged={onLayoutChanged ?? (() => {})} /> : null}</> : null}
    </ScrollView>}
  </View>;
}

function ProfileCard({ session, account }: { session: Session; account: Account | null }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function signOut() {
    if (!supabase) return;
    setBusy(true);
    await unregisterPush().catch(() => {});
    const { error: authError } = await supabase.auth.signOut();
    if (authError) setError(authError.message);
    setBusy(false);
  }

  const client = account?.client;
  return <>
    <View style={ui.card}>
      <Text style={ui.strong}>{account?.full_name || session.user.email}</Text>
      <Text style={ui.small}>{session.user.email} · {account ? roleLabels[account.role] : "Profil en cours de chargement"}</Text>
      {client ? <View style={ui.divider}>
        <Text style={ui.strong}>{client.business_name}</Text>
        <Text style={ui.small}>{formatClientNumber(client.client_number)}{client.contact_name ? ` · ${client.contact_name}` : ""}{client.phone ? ` · ${client.phone}` : ""}</Text>
        {client.delivery_points.map((point) => <Text key={point.id} style={[ui.body, { marginTop: 4 }]}>• {point.label} — {point.address_line}, {point.city}</Text>)}
        <Text style={[ui.small, { marginTop: 6 }]}>Pour modifier ces informations ou ajouter un point de livraison, contactez votre fournisseur.</Text>
      </View> : null}
    </View>
    {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
    <Button label="SE DÉCONNECTER" onPress={() => signOut()} busy={busy} style={{ marginTop: 14 }} />
  </>;
}

// Payment reminders: the client may turn them off only if the supplier allows it (otherwise greyed out).
function ReminderChoiceCard({ account, onChanged }: { account: Account; onChanged: () => void }) {
  const client = account.client as (Account["client"] & { payment_reminders?: boolean; reminder_opt_out_allowed?: boolean; reminder_opt_out?: boolean }) | null;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!client || client.payment_reminders === false) return null;
  const allowed = client.reminder_opt_out_allowed !== false;
  async function toggle(value: boolean) {
    if (!supabase) return;
    setBusy(true);
    setError("");
    const { error: rpcError } = await supabase.rpc("set_my_reminder_opt_out", { p_opt_out: !value });
    if (rpcError) setError(errorMessage(rpcError, "Réglage impossible."));
    else onChanged();
    setBusy(false);
  }
  return <View style={[ui.card, !allowed && { opacity: 0.6 }]}>
    <View style={ui.row}>
      <View style={{ flex: 1 }}>
        <Text style={ui.strong}>Rappels de factures à régler</Text>
        <Text style={ui.small}>{allowed ? "Recevoir un rappel quand une facture arrive à échéance." : "Activés par votre fournisseur pour votre compte : ce réglage ne peut pas être modifié."}</Text>
      </View>
      <Switch value={!client.reminder_opt_out || !allowed} disabled={!allowed || busy} onValueChange={(value) => void toggle(value)} trackColor={{ true: colors.primary, false: colors.line }} />
    </View>
    {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
  </View>;
}

function PasswordCard() {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function changePassword() {
    if (!supabase) return;
    if (password.length < 8) {
      setError("Le mot de passe doit contenir au moins 8 caractères.");
      return;
    }
    setBusy(true); setMessage(""); setError("");
    const { error: authError } = await supabase.auth.updateUser({ password });
    if (authError) setError(errorMessage(authError, "Impossible de modifier le mot de passe."));
    else { setMessage("Mot de passe mis à jour."); setPassword(""); }
    setBusy(false);
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Changer mon mot de passe</Text>
    <Field label="Nouveau mot de passe (8 caractères minimum)" value={password} onChangeText={setPassword} secureTextEntry />
    <View style={{ marginTop: 10, gap: 8 }}>
      {message ? <Text style={ui.success}>{message}</Text> : null}
      {error ? <Text style={ui.error}>{error}</Text> : null}
      <Button label="ENREGISTRER" onPress={() => changePassword()} busy={busy} />
    </View>
  </View>;
}

function ProductsCard() {
  const [visible, setVisible] = useState(false);
  return <View style={ui.card}>
    <Text style={ui.strong}>Catalogue</Text>
    <Text style={ui.small}>Produits, prix, TVA, stock, nouveautés et origine (producteur, région, label).</Text>
    <Button label="GÉRER LES PRODUITS" onPress={() => setVisible(true)} style={{ marginTop: 10 }} />
    <StaffProductsModal visible={visible} onClose={() => setVisible(false)} />
  </View>;
}

// Display preferences for this device: text size and product list layout.
function DisplaySettingsCard({ showProducts }: { showProducts: boolean }) {
  const display = useDisplay();
  const languagesOn = useModules()("languages");
  return <View style={ui.card}>
    <Text style={ui.strong}>Affichage</Text>
    <Text style={ui.small}>Réglages de cet appareil uniquement.</Text>
    {languagesOn ? <>
      <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Langue</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        {languages.map((option) => <Chip key={option.value} label={option.label} selected={display.language === option.value} onPress={() => display.update({ language: option.value })} />)}
      </View>
      <Text style={[ui.small, { marginTop: 4 }]}>Les menus, boutons et libellés principaux sont traduits ; les autres textes restent en français pour l’instant.</Text>
    </> : null}
    <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Taille du texte</Text>
    <View style={[ui.wrapRow, { marginTop: 6 }]}>
      {fontScales.map((option) => <Chip key={option.value} label={option.label} selected={display.fontScale === option.value} onPress={() => display.update({ fontScale: option.value })} />)}
    </View>
    <View style={[ui.divider, { marginTop: 10 }]}>
      <Text style={ui.body}>Aperçu : Commande #128 · 12,5 kg d’oranges</Text>
      <Text style={ui.small}>Les textes de toute l’application suivent ce réglage.</Text>
    </View>
    {showProducts ? <>
      <Text style={[ui.fieldLabel, { marginTop: 14 }]}>Liste des produits</Text>
      <View style={[ui.wrapRow, { marginTop: 6 }]}>
        <Chip label="Avec photos" selected={!display.compactProducts} onPress={() => display.update({ compactProducts: false })} />
        <Chip label="Compacte (sans photos)" selected={display.compactProducts} onPress={() => display.update({ compactProducts: true })} />
      </View>
    </> : null}
    <Button label="RÉTABLIR L’AFFICHAGE PAR DÉFAUT" variant="secondary" onPress={display.reset} style={{ marginTop: 14 }} />
  </View>;
}
