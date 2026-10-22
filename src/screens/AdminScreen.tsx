import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "../ui/Text";
import { SafeAreaView } from "react-native-safe-area-context";
import { roleLabels, type Role , AccountStatus } from "../data/account";
import { createAccount, deleteAccount, fetchAccounts, setAccountStatus, temporaryPassword, invitedByLabel, type AdminAccount } from "../data/admin";
import { assignableRoles } from "../data/team";
import { BackButton as Back, Button, CloseButton, EmptyState, Field, ListGroup, ListRow, Loading, MenuSearch, ScreenHeader, formatDateTime } from "../ui/components";
import { useCan } from "../data/permissions";
import { RolesManager } from "./RolesManager";
import { InvitationsPage } from "./InvitationsPage";
import { SettingsScreen } from "./SettingsScreen";
import { AuditPage, FleetPage, LocationPage } from "./FleetAuditScreens";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { AlertSettingsPanel } from "./NotificationSettings";
import { StaffProductsModal } from "./StaffProductsScreen";
import { PricingModal } from "./PricingScreen";
import { useModules } from "../data/modules";

type Page = "menu" | "accounts" | "settings" | "alerts" | "fleet" | "audit" | "location" | "roles" | "invitations";
const pages: Page[] = ["accounts", "settings", "alerts", "fleet", "audit", "location", "roles", "invitations"];

// Administration home: each button opens its own page.
// initialSection: a page of Paramétrage opened straight (home search); "products" / "pricing" open the catalogue.
export function AdminScreen({ isAdmin = true, initialPage, initialSection }: { isAdmin?: boolean; initialPage?: string; initialSection?: string } = {}) {
  const [page, setPage] = useState<Page>(pages.includes(initialPage as Page) ? initialPage as Page : "menu");
  const [productsVisible, setProductsVisible] = useState(initialPage === "products");
  const [pricingVisible, setPricingVisible] = useState(initialPage === "pricing");
  const can = useCan();
  const pricingOn = useModules()("pricing");

  if (page === "accounts") return <AccountsPage onBack={() => setPage("menu")} onRoles={() => setPage("roles")} />;
  if (page === "alerts") return <View style={ui.screen}>
    <ScreenHeader eyebrow="ADMINISTRATION" title="Notifications et e-mails" right={<BackButton onPress={() => setPage("menu")} />} />
    <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled"><AlertSettingsPanel /></ScrollView>
  </View>;
  if (page === "settings") return <SettingsScreen onBack={() => setPage("menu")} onRoles={() => setPage("roles")} initialPage={initialSection} />;
  if (page === "fleet") return <FleetPage onBack={() => setPage("menu")} />;
  if (page === "audit") return <AuditPage onBack={() => setPage("menu")} />;
  if (page === "location") return <LocationPage onBack={() => setPage("menu")} isAdmin={isAdmin} />;
  if (page === "invitations") return <InvitationsPage scope="mine" header={<BackButton onPress={() => setPage("menu")} />} />;
  if (page === "roles") return <RolesManager header={<ScreenHeader eyebrow="ADMINISTRATION" title="Rôles et accès" right={<BackButton onPress={() => setPage("menu")} />} />} />;

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ADMINISTRATION" title="Admin" />
    <ScrollView contentContainerStyle={ui.content}>
      <MenuSearch>
      {isAdmin ? <ListGroup title="Comptes et réglages">
        <ListRow icon="person-outline" title="Comptes" detail="Validation des comptes de vos clients, suspension, rôle, ajout d’un membre de l’équipe." onPress={() => setPage("accounts")} />
        <ListRow icon="key-outline" title="Rôles et accès" detail="Qui a quel rôle, ce que chaque rôle permet, voir les droits d’une personne." onPress={() => setPage("roles")} />
        <ListRow icon="mail-open-outline" title="Invitations" detail="Qui a invité qui, quand, qui a accepté et quand." onPress={() => setPage("invitations")} />
        <ListRow icon="options-outline" title="Paramétrage" detail="Onglets et droits par thème, profil et utilisateur ; options des clients ; accueil." onPress={() => setPage("settings")} />
        <ListRow icon="notifications-outline" title="Notifications et e-mails" detail="Événements notifiés et service d’envoi." onPress={() => setPage("alerts")} />
      </ListGroup> : null}
      <ListGroup title="Exploitation">
        {can("products.manage") ? <ListRow icon="leaf-outline" title="Produits" detail="Catalogue, prix, TVA, stock, nouveautés et origine." onPress={() => setProductsVisible(true)} /> : null}
        {can("products.manage") && pricingOn ? <ListRow icon="pricetag-outline" title="Remises et tarifs" detail="Remises, prix négociés et groupes de clients." onPress={() => setPricingVisible(true)} /> : null}
        {can("fleet.manage") ? <ListRow icon="car-outline" title="Flotte" detail="Véhicules proposés au livreur à l’expédition." onPress={() => setPage("fleet")} /> : null}
        {can("audit.view") ? <ListRow icon="time-outline" title="Journal des actions" detail="Qui a fait quoi et quand, sur tout le système." onPress={() => setPage("audit")} /> : null}
        {can("location.view") ? <ListRow icon="location-outline" title="Localisation" detail="Dernière position des comptes qui la partagent." onPress={() => setPage("location")} /> : null}
      </ListGroup>
      </MenuSearch>
    </ScrollView>
    <StaffProductsModal visible={productsVisible} onClose={() => setProductsVisible(false)} />
    <PricingModal visible={pricingVisible} onClose={() => setPricingVisible(false)} />
  </View>;
}

function BackButton({ onPress }: { onPress: () => void }) {
  return <Back label="Admin" onPress={onPress} />;
}

const statusOptions = [
  { key: "all", label: "Tous" },
  { key: "pending", label: "En attente de validation" },
  { key: "active", label: "Actifs" },
  { key: "suspended", label: "Suspendus" },
  { key: "refused", label: "Refusés" },
  { key: "deleted", label: "Supprimés" },
];

const statusStyle: Record<AccountStatus, { label: string; color: string; background: string }> = {
  pending: { label: "En attente", color: "#7a5a12", background: "#fbf0d5" },
  active: { label: "Actif", color: colors.primary, background: colors.primarySoft },
  suspended: { label: "Suspendu", color: colors.amber, background: "#fdf3e1" },
  refused: { label: "Refusé", color: colors.danger, background: "#f8e5e1" },
};

function AccountsPage({ onBack, onRoles }: { onBack: () => void; onRoles: () => void }) {
  const [accounts, setAccounts] = useState<AdminAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [role, setRole] = useState("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    setError("");
    try {
      setAccounts(await fetchAccounts());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les comptes."));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, []);

  async function run(account: AdminAccount, task: () => Promise<void>) {
    setBusyId(account.id);
    try {
      await task();
      await reload();
    } catch (cause) {
      notify("Compte", errorMessage(cause, "L’opération a échoué."));
    } finally {
      setBusyId(null);
    }
  }

  function changeStatus(account: AdminAccount, status: AccountStatus) {
    if (status === "active" || status === "pending") {
      void run(account, () => setAccountStatus(account.id, status));
      return;
    }
    notify(status === "refused" ? "Refuser le compte" : "Suspendre le compte", `${account.email} ne pourra plus se connecter. Vous pourrez le réactiver plus tard.`, [
      { text: "Retour", style: "cancel" },
      { text: status === "refused" ? "Refuser" : "Suspendre", style: "destructive", onPress: () => void run(account, () => setAccountStatus(account.id, status)) },
    ]);
  }

  function remove(account: AdminAccount, restore: boolean) {
    if (restore) { void run(account, () => deleteAccount(account.id, true)); return; }
    notify("Supprimer le compte", `${account.email} ne pourra plus se connecter et disparaît des listes. Le compte reste visible avec le filtre « Supprimés » et peut être restauré.`, [
      { text: "Retour", style: "cancel" },
      { text: "Supprimer", style: "destructive", onPress: () => void run(account, () => deleteAccount(account.id)) },
    ]);
  }

  // Deleted accounts only show with the « Supprimés » filter.
  const live = accounts.filter((account) => !account.deleted_at);
  const counts: Record<string, number> = {
    all: live.length,
    pending: live.filter((account) => account.status === "pending").length,
    active: live.filter((account) => account.status === "active").length,
    suspended: live.filter((account) => account.status === "suspended").length,
    refused: live.filter((account) => account.status === "refused").length,
    deleted: accounts.length - live.length,
  };

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return accounts.filter((account) => (status === "deleted" ? !!account.deleted_at : !account.deleted_at && (status === "all" || account.status === status))
      && (role === "all" || account.role === role || (role === "supervisor" && account.role === "staff"))
      && `${account.email} ${account.full_name} ${account.client_name ?? ""}`.toLocaleLowerCase("fr").includes(term));
  }, [accounts, search, status, role]);

  const filters: Filter[] = [
    { kind: "choice", title: "Statut", options: statusOptions.map((option) => ({ ...option, count: counts[option.key] ?? 0 })), value: status, defaultValue: "all", onChange: setStatus },
    { kind: "choice", title: "Rôle", options: [{ key: "all", label: "Tous" }, ...(["admin", "supervisor", "production", "driver", "customer"] as Role[]).map((item) => ({ key: item, label: roleLabels[item] }))], value: role, defaultValue: "all", onChange: setRole },
  ];

  return <View style={ui.screen}>
    <ScreenHeader eyebrow={`${counts.pending} EN ATTENTE DE VALIDATION`} title="Comptes" right={<View style={[ui.row, { gap: 8 }]}><BackButton onPress={onBack} /><Button label="+ AJOUTER" onPress={() => setAdding(true)} /></View>} />
    <FilterBar search={search} onSearch={setSearch} placeholder="E-mail, nom ou client" filters={filters} />
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(account) => account.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
      ListEmptyComponent={error ? null : <EmptyState title="Aucun compte" body="Aucun compte ne correspond à ces filtres." />}
      renderItem={({ item }) => {
        const busy = busyId === item.id;
        const state = statusStyle[item.status] ?? statusStyle.pending;
        return <View style={[ui.card, item.status === "pending" && styles.pendingCard, (item.status === "refused" || item.status === "suspended") && { opacity: 0.75 }]}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.email}{item.is_self ? " (vous)" : ""}</Text>
            <View style={[ui.badge, { backgroundColor: state.background }]}><Text style={[ui.badgeText, { color: state.color }]}>{state.label}</Text></View>
          </View>
          <Text style={ui.small}>{roleLabels[item.role] ?? item.role}{item.full_name ? ` · ${item.full_name}` : ""}{item.client_name ? ` · fiche ${item.client_name}` : ""}</Text>
          <Text style={ui.small}>Créé le {formatDateTime(item.created_at)}{item.last_sign_in_at ? ` · dernière connexion ${formatDateTime(item.last_sign_in_at)}` : " · jamais connecté"}</Text>
          {item.invited_by ? <Text style={ui.small}>Invité par {invitedByLabel(item.invited_by)}</Text> : null}
          {item.email_confirmed === false ? <Text style={[ui.small, { color: colors.amber }]}>E-mail pas encore confirmé : le compte ne peut pas être activé avant.</Text> : null}
          {item.deleted_at ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
            <Text style={[ui.small, { color: colors.danger, flex: 1 }]}>Supprimé le {formatDateTime(item.deleted_at)}</Text>
            <Button label="RESTAURER" variant="secondary" onPress={() => remove(item, true)} busy={busy} />
          </View> : !item.is_self ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
            {item.status === "pending" ? <>
              <Button label="VALIDER" onPress={() => changeStatus(item, "active")} busy={busy} style={{ flexGrow: 1 }} />
              <Button label="SUSPENDRE" variant="secondary" onPress={() => changeStatus(item, "suspended")} disabled={busy} />
              <Button label="REFUSER" variant="danger" onPress={() => changeStatus(item, "refused")} disabled={busy} />
            </> : item.status === "active" ? <Button label="SUSPENDRE" variant="danger" onPress={() => changeStatus(item, "suspended")} disabled={busy} />
              : <>
                <Button label="RÉACTIVER" onPress={() => changeStatus(item, "active")} busy={busy} />
                <Button label="REMETTRE EN ATTENTE" variant="secondary" onPress={() => changeStatus(item, "pending")} disabled={busy} />
              </>}
            {/* A client's account belongs to its own space: only that space (or Appro+) deletes it. */}
            {!item.client_name ? <Button label="SUPPRIMER" variant="danger" onPress={() => remove(item, false)} disabled={busy} /> : null}
          </View> : null}
          {/* One place for roles: Rôles et accès (the former profile chips here followed another set of rights). */}
          {!item.is_self && !item.client_name && !item.deleted_at ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
            <Button label="RÔLES ET ACCÈS" variant="secondary" onPress={onRoles} />
          </View> : null}
        </View>;
      }}
    />}
    <AddAccountModal visible={adding} onClose={() => setAdding(false)} onCreated={() => { setAdding(false); void reload(); }} />
  </View>;
}

function AddAccountModal({ visible, onClose, onCreated }: { visible: boolean; onClose: () => void; onCreated: () => void }) {
  const [email, setEmail] = useState("");
  const [fullName, setFullName] = useState("");
  const [role, setRole] = useState<Role>("supervisor");
  const [password, setPassword] = useState(temporaryPassword());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setEmail("");
    setFullName("");
    setRole("supervisor");
    setPassword(temporaryPassword());
    setError("");
  }, [visible]);

  async function create() {
    if (!email.trim() || password.length < 8) {
      setError("Renseignez l’e-mail et un mot de passe d’au moins 8 caractères.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      if (role === "customer") return;
      const { existing } = await createAccount({ email, fullName, role, password });
      notify(existing ? "Compte rattaché" : "Compte créé", existing
        ? `${email.trim().toLowerCase()} existait déjà : il rejoint votre équipe (${roleLabels[role]}) et il est actif. Il garde son mot de passe actuel (« Mot de passe oublié » s’il ne le connaît pas).`
        : `${email.trim().toLowerCase()} est actif (${roleLabels[role]}).
Mot de passe provisoire : ${password}
Transmettez-le à la personne : elle pourra le changer dans Compte.`);
      onCreated();
    } catch (cause) {
      setError(errorMessage(cause, "Le compte n’a pas pu être créé."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScreenHeader eyebrow="COMPTES" title="Ajouter un compte" right={<CloseButton onPress={onClose} />} />
        <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
          <Field label="E-mail" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          <Field label="Nom (facultatif)" value={fullName} onChangeText={setFullName} autoCapitalize="words" />
          <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Profil</Text>
          <View style={{ gap: 8, marginTop: 6 }}>
            {/* A client has its own space: it joins with an invitation (Clients → Inviter), not from here. */}
            {assignableRoles.filter((option) => option.role !== "customer").map((option) => {
              const selected = role === option.role;
              const label = option.role === "customer" ? "Client" : option.label;
              const body = option.role === "customer" ? "Accès client : l’e-mail doit être celui d’une fiche client pour pouvoir commander." : option.description;
              return <Pressable key={option.role} onPress={() => setRole(option.role)} style={[styles.roleOption, selected && styles.roleSelected]}>
                <Text style={[ui.strong, selected && { color: colors.primary }]}>{label}</Text>
                <Text style={ui.small}>{body}</Text>
              </Pressable>;
            })}
          </View>
          <Field label="Mot de passe provisoire" value={password} onChangeText={setPassword} autoCapitalize="none" />
          <Text style={[ui.small, { marginTop: 6 }]}>Un compte créé ici est actif immédiatement. Communiquez ce mot de passe à la personne ; elle le changera dans Compte.</Text>
          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label="CRÉER LE COMPTE" onPress={() => create()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  pendingCard: { borderColor: "#e3c46f", backgroundColor: "#fffbef" },
  roleOption: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  roleSelected: { borderColor: colors.primary, backgroundColor: colors.primarySoft },
});
