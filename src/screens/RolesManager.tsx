import { useEffect, useMemo, useState } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "../ui/Text";
import {
  addMember, createRole, fetchMemberPermissions, fetchRolesMatrix, removeMember, setMemberRole, setRolePermission,
  type OrgMember, type OrgRole, type RolePermission, type RolesMatrix,
} from "../data/pros";
import { featureBlocks } from "../data/permissions";
import { allModules } from "../data/modules";
import { Button, Chip, CloseButton, EmptyState, Field, ListGroup, Loading, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Labels of the rights, as shown in Paramétrage (the key when a right has no label yet).
const rightLabels: Record<string, string> = Object.fromEntries(featureBlocks.flatMap((block) => block.items.map((item) => [item.key, item.label])));
export const rightLabel = (key: string) => rightLabels[key] ?? key;
const moduleLabel = (key: string | null) => key ? allModules.find((item) => item.key === key)?.label ?? key : "Toujours disponible";

// "Rôles et accès" of one Pro: what each role allows (differences from its template), roles made
// to measure, who has which role, and "see as". Used by the Pro's Responsable (orgId omitted)
// and by Appro+ (orgId of the Pro).
export function RolesManager({ orgId, header }: { orgId?: string | null; header?: React.ReactNode }) {
  const [matrix, setMatrix] = useState<RolesMatrix | null>(null);
  const [error, setError] = useState("");
  const [roleId, setRoleId] = useState<string | null>(null);
  const [tab, setTab] = useState<"roles" | "people">("roles");
  const [creating, setCreating] = useState(false);
  const [seeing, setSeeing] = useState<OrgMember | null>(null);

  async function reload() {
    try {
      const next = await fetchRolesMatrix(orgId);
      setMatrix(next);
      setRoleId((current) => current && next.roles.some((role) => role.id === current) ? current : next.roles[0]?.id ?? null);
      setError("");
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger les rôles. La migration 20261112 est-elle exécutée ?"));
    }
  }
  useEffect(() => { void reload(); }, [orgId]);

  const role = matrix?.roles.find((item) => item.id === roleId) ?? null;
  const groups = useMemo(() => {
    if (!matrix || !role) return [];
    const perms = matrix.permissions.filter((perm) => perm.side === role.side);
    const byModule = new Map<string, RolePermission[]>();
    perms.forEach((perm) => byModule.set(perm.module ?? "", [...(byModule.get(perm.module ?? "") ?? []), perm]));
    return [...byModule.entries()].sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : moduleLabel(a).localeCompare(moduleLabel(b))));
  }, [matrix, role]);

  async function toggle(perm: string, allowed: boolean | null) {
    if (!role) return;
    try {
      await setRolePermission(role.id, perm, allowed);
      await reload();
    } catch (cause) {
      notify("Rôles", errorMessage(cause, "Le droit n’a pas pu être modifié."));
    }
  }

  async function assign(member: OrgMember, target: OrgRole, enabled: boolean) {
    try {
      await setMemberRole(member.id, target.id, enabled);
      await reload();
    } catch (cause) {
      notify("Rôles", errorMessage(cause, "Le rôle n’a pas pu être attribué."));
    }
  }

  if (error && !matrix) return <View style={ui.screen}>{header}<EmptyState title="Rôles indisponibles" body={error} /></View>;
  if (!matrix) return <View style={ui.screen}>{header}<Loading /></View>;

  const sides = (["supplier", "buyer"] as const).filter((side) => matrix.roles.some((item) => item.side === side));
  return <View style={ui.screen}>
    {header}
    <View style={[ui.wrapRow, styles.tabs]}>
      <Chip label="Rôles et droits" selected={tab === "roles"} onPress={() => setTab("roles")} />
      <Chip label={`Personnes (${matrix.members.length})`} selected={tab === "people"} onPress={() => setTab("people")} />
    </View>
    {tab === "roles" ? <ScrollView contentContainerStyle={ui.content}>
      {!matrix.can_edit ? <Text style={[ui.small, styles.note]}>Les rôles de ce Pro sont gérés par Appro+. Vous pouvez les attribuer à vos équipes dans « Personnes ».</Text> : null}
      {sides.map((side) => <View key={side}>
        <Text style={[ui.fieldLabel, { marginTop: 10 }]}>{side === "supplier" ? "Rôles fournisseur" : "Rôles acheteur"}</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {matrix.roles.filter((item) => item.side === side).map((item) =>
            <Chip key={item.id} label={`${item.name}${Object.keys(item.overrides).length ? " ✎" : ""} · ${item.members}`} selected={item.id === roleId} onPress={() => setRoleId(item.id)} />)}
        </View>
      </View>)}
      {matrix.can_edit ? <Button label="+ RÔLE SUR MESURE" variant="secondary" onPress={() => setCreating(true)} style={{ marginTop: 10, alignSelf: "flex-start" }} /> : null}
      {role ? <View style={ui.card}>
        <Text style={ui.strong}>{role.name}</Text>
        <Text style={ui.small}>{role.template ? `Suit le modèle « ${role.template} »${Object.keys(role.overrides).length ? ` avec ${Object.keys(role.overrides).length} différence(s)` : ""}.` : "Rôle sur mesure."} {role.granted.length} droit(s).</Text>
        {groups.map(([module, perms]) => <View key={module} style={styles.group}>
          <Text style={styles.groupTitle}>{moduleLabel(module || null)}</Text>
          {perms.map((perm) => {
            const on = role.granted.includes(perm.key);
            const changed = perm.key in role.overrides;
            return <View key={perm.key} style={styles.perm}>
              <View style={{ flex: 1 }}>
                <Text style={ui.body}>{rightLabel(perm.key)}</Text>
                {changed && role.template ? <Pressable onPress={() => void toggle(perm.key, null)} disabled={!matrix.can_edit}>
                  <Text style={styles.changed}>{on ? "Ajouté" : "Retiré"} par rapport au modèle{matrix.can_edit ? " · revenir au modèle" : ""}</Text>
                </Pressable> : null}
              </View>
              <Switch value={on} disabled={!matrix.can_edit} onValueChange={(value) => void toggle(perm.key, value)} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
            </View>;
          })}
        </View>)}
      </View> : null}
    </ScrollView> : <ScrollView contentContainerStyle={ui.content}>
      <Text style={[ui.small, styles.note]}>Une personne peut avoir plusieurs rôles : ses droits s’additionnent, dans la limite de ce qu’Appro+ a ouvert à votre Pro.</Text>
      <AddMemberCard roles={matrix.roles} onAdded={() => void reload()} />
      {matrix.members.length ? <ListGroup>
        {matrix.members.map((member) => <View key={member.id} style={styles.member}>
          <View style={ui.row}>
            <View style={{ flex: 1 }}>
              <Text style={ui.strong}>{member.full_name || member.email}</Text>
              <Text style={ui.small}>{member.email}{member.status !== "active" ? ` · ${member.status === "pending" ? "en attente" : "suspendu"}` : ""}</Text>
            </View>
            <Pressable onPress={() => setSeeing(member)} hitSlop={8} accessibilityLabel="Voir ses droits"><Ionicons name="eye-outline" size={20} color={colors.primary} /></Pressable>
            <Pressable onPress={() => notify("Retirer de l’équipe", `${member.email} ne fera plus partie de votre Pro. Son compte est conservé.`, [
              { text: "Annuler", style: "cancel" },
              { text: "Retirer", style: "destructive", onPress: () => { void removeMember(member.id).then(() => reload()).catch((cause: unknown) => notify("Équipe", errorMessage(cause, "Le compte n’a pas pu être retiré."))); } },
            ])} hitSlop={8} accessibilityLabel="Retirer de l’équipe"><Ionicons name="person-remove-outline" size={20} color={colors.danger} /></Pressable>
          </View>
          <View style={[ui.wrapRow, { marginTop: 6 }]}>
            {matrix.roles.map((item) => {
              const has = member.roles.includes(item.id);
              return <Chip key={item.id} label={item.name} selected={has} onPress={() => void assign(member, item, !has)} />;
            })}
          </View>
        </View>)}
      </ListGroup> : <EmptyState title="Personne pour l’instant" body="Les comptes de l’équipe apparaissent ici dès qu’ils sont rattachés au Pro." />}
    </ScrollView>}
    <CreateRoleModal visible={creating} roles={matrix.roles} onClose={() => setCreating(false)} onCreate={async (name, side, from) => {
      const id = await createRole(orgId ?? null, name, side, from);
      setCreating(false);
      await reload();
      setRoleId(id);
    }} />
    <SeeAsModal member={seeing} onClose={() => setSeeing(null)} />
  </View>;
}

// A collaborator: an account its owner created (and Appro+ validated), added with a role.
function AddMemberCard({ roles, onAdded }: { roles: OrgRole[]; onAdded: () => void }) {
  const [email, setEmail] = useState("");
  const [roleId, setRoleId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const choices = roles.filter((role) => role.template_key !== "supplier_owner" && role.template_key !== "buyer_owner");
  return <View style={ui.card}>
    <Text style={ui.strong}>Ajouter un collaborateur</Text>
    <Text style={ui.small}>La personne crée d’abord son compte avec son e-mail. Si elle travaille déjà ailleurs, elle aura simplement un espace de plus.</Text>
    <Field label="E-mail" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" />
    <View style={[ui.wrapRow, { marginTop: 4 }]}>
      {choices.map((role) => <Chip key={role.id} label={role.name} selected={roleId === role.id} onPress={() => setRoleId(role.id)} />)}
    </View>
    {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
    <Button label="AJOUTER" disabled={!email.trim() || !roleId} style={{ marginTop: 10 }} onPress={async () => {
      setError("");
      try { await addMember(email, roleId!); setEmail(""); setRoleId(null); onAdded(); } catch (cause) { setError(errorMessage(cause, "Le collaborateur n’a pas pu être ajouté.")); }
    }} />
  </View>;
}

function CreateRoleModal({ visible, roles, onClose, onCreate }: { visible: boolean; roles: OrgRole[]; onClose: () => void; onCreate: (name: string, side: "supplier" | "buyer", from: string | null) => Promise<void> }) {
  const [name, setName] = useState("");
  const [side, setSide] = useState<"supplier" | "buyer">(roles.some((role) => role.side === "supplier") ? "supplier" : "buyer");
  const [from, setFrom] = useState<string | null>(null);
  const [error, setError] = useState("");
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="RÔLES" title="Rôle sur mesure" right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <Field label="Nom du rôle" value={name} onChangeText={setName} placeholder="Ex. Commercial senior" />
        <Text style={ui.fieldLabel}>Côté</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          {roles.some((role) => role.side === "supplier") ? <Chip label="Fournisseur" selected={side === "supplier"} onPress={() => { setSide("supplier"); setFrom(null); }} /> : null}
          {roles.some((role) => role.side === "buyer") ? <Chip label="Acheteur" selected={side === "buyer"} onPress={() => { setSide("buyer"); setFrom(null); }} /> : null}
        </View>
        <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Partir des droits de</Text>
        <View style={[ui.wrapRow, { marginTop: 6 }]}>
          <Chip label="Aucun droit" selected={from === null} onPress={() => setFrom(null)} />
          {roles.filter((role) => role.side === side).map((role) => <Chip key={role.id} label={role.name} selected={from === role.id} onPress={() => setFrom(role.id)} />)}
        </View>
        {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
        <Button label="CRÉER LE RÔLE" disabled={name.trim().length < 2} style={{ marginTop: 14 }} onPress={async () => {
          setError("");
          try { await onCreate(name, side, from); setName(""); } catch (cause) { setError(errorMessage(cause, "Le rôle n’a pas pu être créé.")); }
        }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

// "See as": the real rights of a person (roles, personal exceptions and modules together).
function SeeAsModal({ member, onClose }: { member: OrgMember | null; onClose: () => void }) {
  const [rights, setRights] = useState<string[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    setRights(null);
    setError("");
    if (member) void fetchMemberPermissions(member.id).then(setRights).catch((cause: unknown) => setError(errorMessage(cause, "Impossible de calculer ses droits.")));
  }, [member?.id]);
  return <Modal visible={member !== null} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="VOIR COMME" title={member?.full_name || member?.email || ""} subtitle="Ce que cette personne peut réellement faire." right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content}>
        {error ? <Text style={ui.error}>{error}</Text> : rights === null ? <Loading /> : rights.length === 0
          ? <EmptyState title="Aucun droit" body="Cette personne ne voit rien pour l’instant (compte en attente, aucun rôle ou modules désactivés)." />
          : <ListGroup>{rights.map((key) => <View key={key} style={styles.perm}><Ionicons name="checkmark-circle" size={16} color={colors.primary} /><Text style={[ui.body, { flex: 1 }]}>{rightLabel(key)}</Text></View>)}</ListGroup>}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: 14, paddingTop: 8 },
  note: { marginTop: 8, padding: 8, borderRadius: 8, backgroundColor: colors.primarySoft },
  group: { marginTop: 12, borderTopWidth: 1, borderTopColor: colors.line, paddingTop: 8 },
  groupTitle: { color: colors.primary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5, textTransform: "uppercase" },
  perm: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 6 },
  changed: { color: colors.amber, fontSize: 10, fontWeight: "700", marginTop: 2 },
  member: { paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.line, backgroundColor: colors.white },
});
