import { useEffect, useState } from "react";
import { ScrollView, View } from "react-native";
import { Text, TextInput } from "../ui/Text";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "../lib/supabase";
import { formatClientNumber, roleLabels, type Account } from "../data/account";
import { BackButton, Button, Chip, Field, ListGroup, ListRow, ScreenHeader } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { ui } from "../ui/theme";
import { StaffProductsModal } from "./StaffProductsScreen";
import { PricingModal } from "./PricingScreen";
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
import { confirmSignOut } from "../ui/signOut";
import { fetchMyPro, type MyPro } from "../data/pros";
import { RolesManager } from "./RolesManager";

export type AccountSheet = "sections" | "profile" | "home" | "display" | "password" | "products" | "pricing" | "clients" | "notifications" | "permissions" | "team";

// "Plus": one page, grouped by what people look for — the sections that do not fit in the
// bottom bar, catalogue and clients, administration, then the account's own settings.
// Every entry opens its own page with a way back; a search filters the list.
type Entry = { key: string; icon: TabDef["icon"]; title: string; detail?: string; onPress: () => void };

const sectionTheme = (key: string) => ["calendar", "leaves", "incidents"].includes(key) ? "Équipe" : key === "stats" ? "Pilotage" : "Activité";
const fold = (text: string) => text.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr");

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
  const [myPro, setMyPro] = useState<MyPro | null>(null);
  useEffect(() => { if (account?.role === "customer") void fetchMyPro().then(setMyPro); }, [account?.role]);
  const pages: { key: AccountSheet; icon: TabDef["icon"]; title: string; detail: string; allowed: boolean }[] = [
    { key: "products", icon: "pricetags-outline", title: "Produits", detail: "Catalogue, prix, TVA, stock, nouveautés et origine.", allowed: active && can("products.manage") },
    { key: "pricing", icon: "pricetag-outline", title: "Remises et tarifs", detail: "Remises, prix négociés et groupes de clients.", allowed: active && account?.role !== "customer" && can("products.manage") && mod("pricing") },
    { key: "clients", icon: "people-outline", title: "Clients", detail: "Fiches, points de livraison, QR codes, options.", allowed: active && can("clients.view") },
    { key: "team", icon: "people-outline", title: "Mon équipe", detail: "Collaborateurs, rôles et droits de votre Pro.", allowed: active && account?.role === "customer" && !!myPro },
    { key: "profile", icon: "person-circle-outline", title: "Mon profil et mot de passe", detail: account?.client ? "Votre fiche, vos points de livraison, votre mot de passe." : "Vos informations et votre mot de passe.", allowed: true },
    { key: "notifications", icon: "notifications-outline", title: "Notifications", detail: "Notifications sur le téléphone et par e-mail.", allowed: active },
    { key: "display", icon: "text-outline", title: "Affichage et langue", detail: "Taille du texte, langue, présentation des produits.", allowed: true },
    { key: "home", icon: "options-outline", title: "Personnaliser l’accueil", detail: "Chiffres et raccourcis de votre page d’accueil.", allowed: hasHome && mod("home_custom") },
    { key: "permissions", icon: "shield-checkmark-outline", title: "Autorisations du téléphone", detail: "Appareil photo, micro, position, notifications.", allowed: true },
  ];
  const allowedPages = pages.filter((page) => page.allowed);
  const startPage = allowedPages.some((page) => page.key === initialSheet) ? initialSheet as AccountSheet : null;
  const [page, setPage] = useState<AccountSheet | null>(startPage);
  const [productsVisible, setProductsVisible] = useState(false);
  const [pricingVisible, setPricingVisible] = useState(false);
  const [query, setQuery] = useState("");

  const open = (key: AccountSheet) => key === "products" ? setProductsVisible(true) : key === "pricing" ? setPricingVisible(true) : setPage(key);
  const entry = (key: AccountSheet): Entry[] => allowedPages.filter((item) => item.key === key).map((item) => ({ key: item.key, icon: item.icon, title: item.title, detail: item.detail, onPress: () => open(item.key) }));
  const adminEntries: Entry[] = !sections.some((item) => item.key === "admin") ? [] : [
    { page: "accounts", icon: "person-outline" as const, title: "Comptes", detail: "Comptes de vos clients et de votre équipe : validation, suspension, ajout.", allowed: isAdmin },
    { page: "roles", icon: "key-outline" as const, title: "Rôles et accès", detail: "Qui a quel rôle, ce que chaque rôle permet, voir les droits d’une personne.", allowed: isAdmin },
    { page: "settings", icon: "options-outline" as const, title: "Paramétrage", detail: "Modules, droits par profil, options des clients, entreprise, numérotation, accueil.", allowed: isAdmin },
    { page: "alerts", icon: "notifications-outline" as const, title: "Notifications et e-mails", detail: "Événements notifiés et service d’envoi.", allowed: isAdmin },
    { page: "fleet", icon: "car-outline" as const, title: "Flotte", detail: "Véhicules proposés au livreur à l’expédition.", allowed: can("fleet.manage") },
    { page: "audit", icon: "time-outline" as const, title: "Journal des actions", detail: "Qui a fait quoi et quand, sur tout le système.", allowed: can("audit.view") },
    { page: "location", icon: "location-outline" as const, title: "Localisation", detail: "Dernière position des comptes qui la partagent.", allowed: can("location.view") },
  ].filter((item) => item.allowed).map((item) => ({ key: `admin-${item.page}`, icon: item.icon, title: item.title, detail: item.detail, onPress: () => navigate("admin", { page: item.page }) }));
  const sectionEntries = (theme: string): Entry[] => sections.filter((item) => item.key !== "admin" && sectionTheme(item.key) === theme)
    .map((item) => ({ key: item.key, icon: item.icon, title: item.label, detail: item.description, onPress: () => navigate(item.key) }));

  const groups: { title: string; entries: Entry[] }[] = [
    { title: "Activité", entries: sectionEntries("Activité") },
    { title: "Équipe", entries: sectionEntries("Équipe") },
    { title: "Pilotage", entries: sectionEntries("Pilotage") },
    { title: "Catalogue et clients", entries: [...entry("products"), ...entry("pricing"), ...entry("clients")] },
    { title: "Administration", entries: adminEntries },
    { title: "Mon Pro", entries: entry("team") },
    { title: "Mon compte", entries: [...entry("profile"), ...entry("notifications"), ...entry("display"), ...entry("home"), ...entry("permissions")] },
  ];
  const needle = fold(query.trim());
  const shown = groups.map((group) => ({ ...group, entries: needle ? group.entries.filter((item) => fold(`${item.title} ${item.detail ?? ""}`).includes(needle)) : group.entries }))
    .filter((group) => group.entries.length);

  const current = allowedPages.find((item) => item.key === page);
  if (current) {
    const header = <ScreenHeader eyebrow="PLUS" title={current.title} right={<BackButton label="Plus" onPress={() => setPage(null)} />} />;
    if (current.key === "clients") return <View style={ui.screen}>{header}<StaffClientsScreen embedded /></View>;
    if (current.key === "team") return <RolesManager header={header} />;
    return <View style={ui.screen}>
      {header}
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        {current.key === "profile" ? <><ProfileCard session={session} account={account} onChanged={onLayoutChanged} /><PasswordCard /></> : null}
        {current.key === "permissions" ? <PermissionsCard /> : null}
        {current.key === "home" && account ? <HomeCustomizeCard account={account} onLayoutChanged={onLayoutChanged ?? (() => {})} /> : null}
        {current.key === "display" ? <DisplaySettingsCard showProducts={account?.role === "customer"} /> : null}
        {current.key === "notifications" ? <><MyNotificationsCard />{account?.client && mod("reminders") ? <ReminderChoiceCard account={account} onChanged={onLayoutChanged ?? (() => {})} /> : null}</> : null}
      </ScrollView>
    </View>;
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={session.user.email?.toLocaleUpperCase("fr") ?? "VOTRE ESPACE"} title="Plus" />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      <TextInput value={query} onChangeText={setQuery} placeholder="Rechercher une rubrique ou un réglage" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 10 }]} clearButtonMode="while-editing" />
      {shown.map((group) => <ListGroup key={group.title} title={group.title}>
        {group.entries.map((item) => <ListRow key={item.key} icon={item.icon} title={item.title} detail={item.detail} onPress={item.onPress} />)}
      </ListGroup>)}
      {!shown.length ? <Text style={[ui.small, { marginTop: 14 }]}>Aucune rubrique ne correspond à « {query.trim()} ».</Text> : null}
      <ListGroup>
        <ListRow icon="log-out-outline" title="Se déconnecter" onPress={confirmSignOut} />
      </ListGroup>
    </ScrollView>
    <StaffProductsModal visible={productsVisible} onClose={() => setProductsVisible(false)} />
    <PricingModal visible={pricingVisible} onClose={() => setPricingVisible(false)} />
  </View>;
}

function ProfileCard({ session, account, onChanged }: { session: Session; account: Account | null; onChanged?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // My information: name and phone (20261126 set_my_profile).
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(account?.full_name ?? "");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState("");
  useEffect(() => {
    if (!supabase) return;
    void supabase.from("profiles").select("phone").eq("id", session.user.id).maybeSingle()
      .then(({ data }) => setPhone(((data as { phone?: string | null } | null)?.phone) ?? ""), () => undefined);
  }, [session.user.id]);
  useEffect(() => { setName(account?.full_name ?? ""); }, [account?.full_name]);

  async function saveInfo() {
    if (!supabase) return;
    setSaving(true); setError(""); setSaved("");
    const { error: rpcError } = await supabase.rpc("set_my_profile", { p_full_name: name.trim(), p_phone: phone.trim() || null });
    if (rpcError) setError(errorMessage(rpcError, "Vos informations n’ont pas pu être enregistrées. La migration 20261126 est-elle exécutée ?"));
    else { setSaved("Vos informations sont enregistrées."); setEditing(false); onChanged?.(); }
    setSaving(false);
  }

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
      <Text style={ui.small}>{session.user.email} · {account ? roleLabels[account.role] : "Profil en cours de chargement"}{phone && !editing ? ` · ${phone}` : ""}</Text>
      {editing ? <>
        <Field label="Nom et prénom" value={name} onChangeText={setName} autoCapitalize="words" />
        <Field label="Téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
        <Text style={[ui.small, { marginTop: 6 }]}>L’adresse e-mail sert à vous connecter : pour la changer, contactez votre administrateur.</Text>
        <View style={[ui.wrapRow, { marginTop: 10 }]}>
          <Button label="ENREGISTRER" onPress={() => saveInfo()} busy={saving} />
          <Button label="ANNULER" variant="secondary" onPress={() => { setEditing(false); setName(account?.full_name ?? ""); }} />
        </View>
      </> : <Button label="MODIFIER MES INFORMATIONS" variant="secondary" onPress={() => { setSaved(""); setEditing(true); }} style={{ marginTop: 10 }} />}
      {saved ? <Text style={[ui.success, { marginTop: 6 }]}>{saved}</Text> : null}
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
