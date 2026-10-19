import { useEffect, useMemo, useState } from "react";
import { FlatList, KeyboardAvoidingView, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { roleLabels, type Role } from "../data/account";
import { createAccount, fetchAccounts, setAccountRole, setAccountStatus, temporaryPassword, type AdminAccount } from "../data/admin";
import type { AccountStatus } from "../data/account";
import { assignableRoles } from "../data/team";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader, formatDateTime } from "../ui/components";
import { FilterBar, type Filter } from "../ui/FilterBar";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { PermissionsPanel } from "./PermissionsPanel";
import { StaffProductsModal } from "./StaffProductsScreen";

type Page = "menu" | "accounts" | "permissions";

// Administration home: each button opens its own page.
export function AdminScreen() {
  const [page, setPage] = useState<Page>("menu");
  const [productsVisible, setProductsVisible] = useState(false);

  if (page === "accounts") return <AccountsPage onBack={() => setPage("menu")} />;
  if (page === "permissions") return <View style={ui.screen}>
    <ScreenHeader eyebrow="ADMINISTRATION" title="Profils et droits" right={<BackButton onPress={() => setPage("menu")} />} />
    <ScrollView contentContainerStyle={ui.content}><PermissionsPanel /></ScrollView>
  </View>;

  const entries: { key: string; title: string; body: string; icon: string; onPress: () => void }[] = [
    { key: "accounts", title: "Comptes", body: "Tous les comptes : validation des inscriptions, suspension, refus, rôle, ajout d’un compte.", icon: "👤", onPress: () => setPage("accounts") },
    { key: "permissions", title: "Profils et droits", body: "Ce que chaque profil peut faire : superviseur, production, livreur, client.", icon: "🔑", onPress: () => setPage("permissions") },
    { key: "products", title: "Produits", body: "Catalogue, prix, TVA, stock, nouveautés et origine.", icon: "🥬", onPress: () => setProductsVisible(true) },
  ];

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="ADMINISTRATION" title="Admin" />
    <ScrollView contentContainerStyle={ui.content}>
      {entries.map((entry) => <Pressable key={entry.key} onPress={entry.onPress} style={[ui.card, styles.entry]}>
        <Text style={styles.entryIcon}>{entry.icon}</Text>
        <View style={{ flex: 1 }}>
          <Text style={ui.strong}>{entry.title}</Text>
          <Text style={ui.small}>{entry.body}</Text>
        </View>
        <Text style={styles.chevron}>›</Text>
      </Pressable>)}
    </ScrollView>
    <StaffProductsModal visible={productsVisible} onClose={() => setProductsVisible(false)} />
  </View>;
}

function BackButton({ onPress }: { onPress: () => void }) {
  return <Pressable onPress={onPress} style={styles.back} accessibilityLabel="Retour"><Text style={styles.backText}>‹ Admin</Text></Pressable>;
}

const statusOptions = [
  { key: "all", label: "Tous" },
  { key: "pending", label: "En attente de validation" },
  { key: "active", label: "Actifs" },
  { key: "suspended", label: "Suspendus" },
  { key: "refused", label: "Refusés" },
];

const statusStyle: Record<AccountStatus, { label: string; color: string; background: string }> = {
  pending: { label: "En attente", color: "#7a5a12", background: "#fbf0d5" },
  active: { label: "Actif", color: colors.green, background: "#dcebd7" },
  suspended: { label: "Suspendu", color: colors.amber, background: "#fdf3e1" },
  refused: { label: "Refusé", color: colors.danger, background: "#f8e5e1" },
};

function AccountsPage({ onBack }: { onBack: () => void }) {
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

  const counts: Record<string, number> = {
    all: accounts.length,
    pending: accounts.filter((account) => account.status === "pending").length,
    active: accounts.filter((account) => account.status === "active").length,
    suspended: accounts.filter((account) => account.status === "suspended").length,
    refused: accounts.filter((account) => account.status === "refused").length,
  };

  const visible = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("fr");
    return accounts.filter((account) => (status === "all" || account.status === status)
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
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.green} />}
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
          {!item.is_self ? <View style={[ui.wrapRow, { marginTop: 10 }]}>
            {item.status === "pending" ? <>
              <Button label="VALIDER" onPress={() => changeStatus(item, "active")} busy={busy} style={{ flexGrow: 1 }} />
              <Button label="SUSPENDRE" variant="secondary" onPress={() => changeStatus(item, "suspended")} disabled={busy} />
              <Button label="REFUSER" variant="danger" onPress={() => changeStatus(item, "refused")} disabled={busy} />
            </> : item.status === "active" ? <Button label="SUSPENDRE" variant="danger" onPress={() => changeStatus(item, "suspended")} disabled={busy} />
              : <>
                <Button label="RÉACTIVER" onPress={() => changeStatus(item, "active")} busy={busy} />
                <Button label="REMETTRE EN ATTENTE" variant="secondary" onPress={() => changeStatus(item, "pending")} disabled={busy} />
              </>}
          </View> : null}
          {!item.is_self && !item.client_name ? <View style={[ui.wrapRow, { marginTop: 8 }]}>
            {assignableRoles.filter((option) => option.role !== item.role && !(option.role === "supervisor" && item.role === "staff")).map((option) => <Chip
              key={option.role}
              label={option.role === "customer" ? "Retirer de l’équipe" : `→ ${option.label}`}
              selected={false}
              onPress={() => void run(item, () => setAccountRole(item.email, option.role))}
            />)}
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
      await createAccount({ email, fullName, role, password });
      notify("Compte créé", `${email.trim().toLowerCase()} est actif${role === "customer" ? "" : ` (${roleLabels[role]})`}.\nMot de passe provisoire : ${password}\nTransmettez-le à la personne : elle pourra le changer dans Compte.`);
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
            {assignableRoles.map((option) => {
              const selected = role === option.role;
              const label = option.role === "customer" ? "Client" : option.label;
              const body = option.role === "customer" ? "Accès client : l’e-mail doit être celui d’une fiche client pour pouvoir commander." : option.description;
              return <Pressable key={option.role} onPress={() => setRole(option.role)} style={[styles.roleOption, selected && styles.roleSelected]}>
                <Text style={[ui.strong, selected && { color: colors.green }]}>{label}</Text>
                <Text style={ui.small}>{body}</Text>
              </Pressable>;
            })}
          </View>
          <Field label="Mot de passe provisoire" value={password} onChangeText={setPassword} autoCapitalize="none" />
          <Text style={[ui.small, { marginTop: 6 }]}>Un compte créé ici est actif immédiatement. Communiquez ce mot de passe à la personne ; elle le changera dans Compte.</Text>
          {error ? <Text style={[ui.error, { marginTop: 12 }]}>{error}</Text> : null}
          <Button label="CRÉER LE COMPTE" onPress={() => void create()} busy={busy} style={{ marginTop: 16 }} />
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  entry: { flexDirection: "row", alignItems: "center", gap: 14, paddingVertical: 18 },
  entryIcon: { fontSize: 26 },
  chevron: { color: colors.muted, fontSize: 26 },
  back: { borderWidth: 1, borderColor: colors.line, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: colors.white },
  backText: { color: colors.green, fontSize: 12, fontWeight: "800" },
  pendingCard: { borderColor: "#e3c46f", backgroundColor: "#fffbef" },
  roleOption: { padding: 12, borderRadius: 10, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  roleSelected: { borderColor: colors.green, backgroundColor: "#f3f8f1" },
});
