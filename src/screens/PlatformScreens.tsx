import { useEffect, useMemo, useState } from "react";
import { FlatList, RefreshControl, ScrollView, StyleSheet, View , Pressable } from "react-native";
import { Text } from "../ui/Text";
import {
  fetchMyPlatformRole, fetchPlatformTeam, fetchPros, platformRoleLabels, setPlatformMember, setProStatus,
  type PlatformMember, type PlatformRole, type ProStatus, type ProSummary,
} from "../data/platform";
import { Button, Chip, EmptyState, Field, ListGroup, Loading, ScreenHeader, formatDateTime, formatDay } from "../ui/components";
import { FilterBar } from "../ui/FilterBar";
import { errorMessage, notify } from "../ui/notify";
import { ProDetailModal } from "./PlatformAdmin";

import { colors, ui } from "../ui/theme";
import { fetchInvitations, type InvitationRecord } from "../data/directory";
import { useNav } from "../ui/navigation";

const statusStyle: Record<ProStatus, { label: string; color: string; background: string }> = {
  pending: { label: "À valider", color: "#7a5a12", background: "#fbefc9" },
  active: { label: "Actif", color: "#1d6b36", background: "#d6efdc" },
  suspended: { label: "Suspendu", color: "#5f6560", background: "#e9eae7" },
  refused: { label: "Refusé", color: colors.danger, background: "#f8e2dd" },
};

// Appro+ → Pros: every professional on the platform, to validate, suspend or reactivate.
export function ProsScreen() {
  const [pros, setPros] = useState<ProSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ProStatus | "all">("all");
  const [kind, setKind] = useState("all");
  const [opened, setOpened] = useState<string | null | undefined>(undefined);
  // The latest invitations (Appro+ is told of each one): who invited whom, when, accepted or not.
  const [invitations, setInvitations] = useState<InvitationRecord[]>([]);
  const { navigate } = useNav();

  async function reload(refresh = false) {
    if (refresh) setRefreshing(true);
    void fetchInvitations("platform").then(setInvitations).catch(() => setInvitations([]));
    try {
      setPros(await fetchPros());
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les Pros. Les migrations 20261108 à 20261110 sont-elles exécutées ?"));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }
  useEffect(() => { void reload(); }, []);

  function decide(pro: ProSummary, next: ProStatus) {
    const verbs: Record<ProStatus, string> = { active: pro.status === "pending" ? "Valider" : "Réactiver", suspended: "Suspendre", refused: "Refuser", pending: "Remettre en attente" };
    notify(`${verbs[next]} ${pro.name}`, next === "suspended" ? "Ses comptes ne pourront plus travailler sur Appro+ jusqu’à réactivation. Ses données sont conservées." : "", [
      { text: "Annuler", style: "cancel" },
      { text: verbs[next], style: next === "active" ? "default" : "destructive", onPress: () => {
        void setProStatus(pro.id, next).then(() => reload()).catch((cause: unknown) => notify("Pros", errorMessage(cause, "Le statut n’a pas pu être modifié.")));
      } },
    ]);
  }

  const counts = useMemo(() => ({ pending: pros.filter((pro) => pro.status === "pending").length }), [pros]);
  const recentInvitations = invitations.filter((item) => Date.now() - new Date(item.created_at).getTime() < 7 * 86400000);
  const needle = search.trim().toLocaleLowerCase("fr");
  const visible = pros.filter((pro) => (status === "all" || pro.status === status)
    && (kind === "all" || (kind === "supplier" ? pro.is_supplier : pro.is_buyer))
    && (!needle || `${pro.name} ${pro.email} ${pro.phone}`.toLocaleLowerCase("fr").includes(needle)));

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+" title="Pros" subtitle={counts.pending ? `${counts.pending} Pro(s) à valider` : `${pros.length} Pro(s) sur la plateforme`}
      right={<Button label="+ NOUVEAU" variant="secondary" onPress={() => setOpened(null)} />} />
    <FilterBar search={search} onSearch={setSearch} placeholder="Nom, e-mail ou téléphone" filters={[
      { kind: "choice", title: "Statut", value: status, defaultValue: "all", onChange: (value) => setStatus(value as ProStatus | "all"), options: [
        { key: "all", label: "Tous" }, { key: "pending", label: "À valider" }, { key: "active", label: "Actifs" }, { key: "suspended", label: "Suspendus" }, { key: "refused", label: "Refusés" },
      ] },
      { kind: "choice", title: "Activité", value: kind, defaultValue: "all", onChange: setKind, options: [
        { key: "all", label: "Toutes" }, { key: "supplier", label: "Fournisseurs" }, { key: "buyer", label: "Acheteurs" },
      ] },
    ]} />
    {recentInvitations.length ? <Pressable onPress={() => navigate("platformSettings", { page: "invitations" })} style={styles.invitations}>
      <Text style={[ui.strong, { color: colors.primary }]}>{recentInvitations.length} invitation(s) ces 7 derniers jours · {recentInvitations.filter((item) => !item.acceptances.length).length} pas encore acceptée(s)</Text>
      {recentInvitations.slice(0, 3).map((item) => <Text key={item.code} style={ui.small} numberOfLines={1}>
        {formatDateTime(item.created_at)} · {item.invited_by ?? "—"} ({item.org_name}) → {item.client_name ?? item.name ?? item.contact ?? "sans nom"}{item.acceptances.length ? ` · acceptée par ${item.acceptances[0].name ?? "—"}` : ""}
      </Text>)}
      <Text style={[ui.small, { color: colors.primary, fontWeight: "800" }]}>Voir toutes les invitations ›</Text>
    </Pressable> : null}
    {loading ? <Loading /> : <FlatList
      data={visible}
      keyExtractor={(pro) => pro.id}
      contentContainerStyle={ui.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void reload(true)} tintColor={colors.primary} />}
      ListHeaderComponent={error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      ListEmptyComponent={<EmptyState title="Aucun Pro" body="Aucun Pro ne correspond à ces filtres." />}
      renderItem={({ item }) => {
        const style = statusStyle[item.status];
        return <Pressable style={ui.card} onPress={() => setOpened(item.id)}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]} numberOfLines={1}>{item.name}</Text>
            <View style={[ui.badge, { backgroundColor: style.background }]}><Text style={[ui.badgeText, { color: style.color }]}>{style.label}</Text></View>
          </View>
          <View style={[ui.wrapRow, { marginTop: 6 }]}>
            {item.is_supplier ? <Text style={styles.kind}>Fournisseur · {item.clients} client(s)</Text> : null}
            {item.is_buyer ? <Text style={styles.kind}>Acheteur · {item.suppliers} fournisseur(s)</Text> : null}
          </View>
          <Text style={[ui.small, { marginTop: 4 }]}>{[item.email, item.phone].filter(Boolean).join(" · ") || "Coordonnées à compléter"} · {item.members} compte(s) · depuis le {formatDay(item.created_at, { day: "numeric", month: "short", year: "numeric" })}</Text>
          {item.trial_until ? <Text style={[ui.small, { marginTop: 4, color: colors.amber, fontWeight: "800" }]}>{item.status === "active"
            ? `En essai jusqu’au ${formatDateTime(item.trial_until)} : validez-le pour qu’il reste actif.`
            : `Essai terminé le ${formatDateTime(item.trial_until)} : à valider pour le réactiver.`}</Text> : null}
          <View style={[ui.wrapRow, { marginTop: 8 }]}>
            {item.status !== "active" ? <Button label={item.status === "pending" || item.trial_until ? "VALIDER" : "RÉACTIVER"} onPress={() => decide(item, "active")} /> : null}
            {item.status === "active" && item.trial_until ? <Button label="VALIDER DÉFINITIVEMENT" onPress={() => decide(item, "active")} /> : null}
            {item.status === "active" ? <Button label="SUSPENDRE" variant="danger" onPress={() => decide(item, "suspended")} /> : null}
            {item.status === "pending" ? <Button label="REFUSER" variant="danger" onPress={() => decide(item, "refused")} /> : null}
          </View>
        </Pressable>;
      }}
    />}
    <ProDetailModal orgId={opened ?? null} visible={opened !== undefined} onClose={() => setOpened(undefined)} onChanged={() => void reload()} />
  </View>;
}

// Appro+ → Équipe Appro+: the platform's own staff and their platform roles (separate from the Pros).
export function PlatformTeamScreen() {
  const [members, setMembers] = useState<PlatformMember[]>([]);
  const [me, setMe] = useState<PlatformRole | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<PlatformRole>("support");

  async function reload() {
    try {
      const [team, mine] = await Promise.all([fetchPlatformTeam(), fetchMyPlatformRole()]);
      setMembers(team);
      setMe(mine);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger l’équipe Appro+."));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => { void reload(); }, []);
  const superadmin = me === "superadmin";

  async function add() {
    setError("");
    try {
      await setPlatformMember(email, role);
      setEmail("");
      await reload();
    } catch (cause) {
      setError(errorMessage(cause, "Le membre n’a pas pu être ajouté."));
    }
  }

  function change(member: PlatformMember, next: PlatformRole | null) {
    notify(next ? "Changer le rôle" : "Retirer de l’équipe Appro+", next ? `${member.email} : ${platformRoleLabels[next].label}.` : `${member.email} n’aura plus accès à la console Appro+.`, [
      { text: "Annuler", style: "cancel" },
      { text: next ? "Confirmer" : "Retirer", style: next ? "default" : "destructive", onPress: () => {
        void setPlatformMember(member.email, next).then(() => reload()).catch((cause: unknown) => notify("Équipe Appro+", errorMessage(cause, "La modification a échoué.")));
      } },
    ]);
  }

  return <View style={ui.screen}>
    <ScreenHeader eyebrow="APPRO+" title="Équipe Appro+" subtitle="Les comptes de la plateforme. Ils n’appartiennent à aucun Pro et ne voient pas les données des Pros." />
    {loading ? <Loading /> : <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
      {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
      <ListGroup title="Membres">
        {members.map((member) => <View key={member.user_id} style={styles.member}>
          <View style={ui.row}>
            <View style={{ flex: 1 }}>
              <Text style={ui.strong}>{member.full_name || member.email}</Text>
              <Text style={ui.small}>{member.email} · {platformRoleLabels[member.role]?.label ?? member.role}</Text>
            </View>
          </View>
          {superadmin && member.role !== "superadmin" ? <View style={[ui.wrapRow, { marginTop: 6 }]}>
            {(Object.keys(platformRoleLabels) as PlatformRole[]).filter((key) => key !== member.role && key !== "superadmin").map((key) =>
              <Chip key={key} label={platformRoleLabels[key].label} selected={false} onPress={() => change(member, key)} />)}
            <Chip label="Retirer" selected={false} onPress={() => change(member, null)} />
          </View> : null}
        </View>)}
      </ListGroup>
      {superadmin ? <View style={ui.card}>
        <Text style={ui.strong}>Ajouter un membre</Text>
        <Text style={ui.small}>La personne crée d’abord son compte avec une adresse qui n’appartient à aucun Pro.</Text>
        <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
        <View style={[ui.wrapRow, { marginTop: 4 }]}>
          {(Object.keys(platformRoleLabels) as PlatformRole[]).filter((key) => key !== "superadmin").map((key) =>
            <Chip key={key} label={platformRoleLabels[key].label} selected={role === key} onPress={() => setRole(key)} />)}
        </View>
        <Text style={[ui.small, { marginTop: 6 }]}>{platformRoleLabels[role].detail}</Text>
        <Button label="AJOUTER À L’ÉQUIPE" onPress={() => add()} disabled={!email.trim()} style={{ marginTop: 10 }} />
      </View> : null}
    </ScrollView>}
  </View>;
}

const styles = StyleSheet.create({
  invitations: { marginHorizontal: 14, marginTop: 8, padding: 10, borderRadius: 10, borderWidth: 1, borderColor: colors.primary, backgroundColor: colors.primarySoft, gap: 2 },
  kind: { color: colors.primary, fontSize: 11, fontWeight: "700", backgroundColor: colors.primarySoft, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 10, overflow: "hidden" },
  member: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
});
