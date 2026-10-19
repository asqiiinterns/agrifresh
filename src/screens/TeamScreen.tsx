import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { roleLabels, type Role } from "../data/account";
import { assignableRoles, fetchTeam, setMemberRole, type TeamMember } from "../data/team";
import { Button, Chip, CloseButton, EmptyState, Field, Loading, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// Admins give roles to people who already activated an account in the app.
export function TeamModal({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("supervisor");
  const [busy, setBusy] = useState(false);

  async function reload() {
    setError("");
    try {
      setTeam(await fetchTeam());
    } catch (cause) {
      setError(errorMessage(cause, "Impossible de charger l’équipe."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!visible) return;
    setLoading(true);
    void reload();
  }, [visible]);

  async function assign(targetEmail: string, targetRole: Role) {
    setBusy(true);
    setError("");
    try {
      await setMemberRole(targetEmail, targetRole);
      setEmail("");
      notify("Équipe", `${targetEmail} : ${targetRole === "customer" ? "retiré de l’équipe" : roleLabels[targetRole]}. La personne doit se reconnecter.`);
      await reload();
    } catch (cause) {
      setError(errorMessage(cause, "Le rôle n’a pas pu être modifié."));
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="ADMINISTRATION" title="Équipe" right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <View style={ui.card}>
          <Text style={ui.strong}>Donner un rôle</Text>
          <Text style={ui.small}>La personne crée d’abord son compte dans l’application (« Activer mon accès »), avec une adresse qui n’est pas celle d’une fiche client.</Text>
          <Field label="E-mail du compte" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" />
          <View style={{ gap: 8, marginTop: 12 }}>
            {assignableRoles.map((item) => <Pressable key={item.role} onPress={() => setRole(item.role)} style={[ui.card, { marginTop: 0 }, role === item.role && { borderColor: colors.green, backgroundColor: "#f3f8f1" }]}>
              <Text style={[ui.strong, role === item.role && { color: colors.green }]}>{item.label}</Text>
              <Text style={ui.small}>{item.description}</Text>
            </Pressable>)}
          </View>
          {error ? <Text style={[ui.error, { marginTop: 10 }]}>{error}</Text> : null}
          <Button label="ENREGISTRER" onPress={() => void assign(email, role)} busy={busy} disabled={!email.trim()} style={{ marginTop: 12 }} />
        </View>

        <Text style={[ui.strong, { marginTop: 18 }]}>Membres</Text>
        {loading ? <Loading /> : team.length === 0 ? <EmptyState title="Aucun membre" /> : team.map((member) => <View key={member.id} style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>{member.email}</Text>
            <Text style={[ui.small, { color: colors.green, fontWeight: "800" }]}>{roleLabels[member.role] ?? member.role}</Text>
          </View>
          {member.full_name ? <Text style={ui.small}>{member.full_name}</Text> : null}
          <View style={[ui.wrapRow, { marginTop: 8 }]}>
            {assignableRoles.filter((item) => item.role !== member.role && item.role !== "customer").map((item) => <Chip key={item.role} label={item.label} selected={false} onPress={() => void assign(member.email, item.role)} />)}
            <Chip label="Retirer" selected={false} onPress={() => notify("Retirer de l’équipe", `${member.email} perdra ses accès internes.`, [
              { text: "Retour", style: "cancel" },
              { text: "Retirer", style: "destructive", onPress: () => void assign(member.email, "customer") },
            ])} />
          </View>
        </View>)}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
