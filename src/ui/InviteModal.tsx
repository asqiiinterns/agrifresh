import { useEffect, useState } from "react";
import { Linking, Modal, Platform, Pressable, ScrollView, Share, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "./Text";
import { createInvitation, type Invitation, type InvitationSide } from "../data/directory";
import { Button, CloseButton, Field, ScreenHeader } from "./components";
import { errorMessage, notify } from "./notify";
import { colors, ui } from "./theme";

// The link opened by the person invited: the web app with the code (the code alone in the app).
export function invitationLink(invitation: Invitation) {
  const base = invitation.app_url || (Platform.OS === "web" && typeof window !== "undefined" ? window.location.origin : "");
  return base ? `${base}/?invite=${invitation.code}` : "";
}

export function invitationMessage(invitation: Invitation, name: string) {
  const link = invitationLink(invitation);
  const role = invitation.side === "client" ? "pour commander chez lui" : "pour lui proposer vos produits";
  return [
    `Bonjour${name.trim() ? ` ${name.trim()}` : ""},`,
    "",
    `${invitation.org_name} vous invite sur Appro+ ${role} : commandes, livraisons, factures et messages au même endroit.`,
    "",
    link ? `Créez votre compte avec ce lien : ${link}` : "Installez l’application Appro+, créez votre compte puis saisissez ce code dans « J’ai un code d’invitation ».",
    `Code d’invitation : ${invitation.code}`,
  ].join("\n");
}

type Props = {
  visible: boolean;
  side: InvitationSide;
  onClose: () => void;
  // From a client record: the person becomes the Responsable of that client's space.
  clientId?: string | null;
  name?: string;
  phone?: string;
  email?: string;
  // Appro+ invites on behalf of a Pro (20261126).
  forOrgId?: string;
  forOrgName?: string;
};

// Invite someone to install Appro+: one code, sent by WhatsApp, Messenger, SMS, e-mail or any app.
export function InviteModal({ visible, side, onClose, clientId = null, name: initialName = "", phone: initialPhone = "", email: initialEmail = "", forOrgId, forOrgName }: Props) {
  const [name, setName] = useState(initialName);
  const [phone, setPhone] = useState(initialPhone);
  const [email, setEmail] = useState(initialEmail);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setName(initialName); setPhone(initialPhone); setEmail(initialEmail); setInvitation(null); setError("");
    // A client record is known: the invitation is ready at once.
    if (clientId) void create(initialName);
  }, [visible, clientId]);

  async function create(forName = name) {
    setBusy(true);
    setError("");
    try {
      setInvitation(await createInvitation(side, clientId, forName, phone || email, forOrgId ?? null));
    } catch (cause) {
      setError(errorMessage(cause, "L’invitation n’a pas pu être créée. La migration 20261120 est-elle exécutée ?"));
    } finally {
      setBusy(false);
    }
  }

  const message = invitation ? invitationMessage(invitation, name) : "";
  const link = invitation ? invitationLink(invitation) : "";
  const digits = phone.replace(/[^\d+]/g, "").replace(/^\+/, "");

  async function open(url: string, fallback = true) {
    try {
      await Linking.openURL(url);
    } catch {
      if (fallback) await shareOrCopy();
      else notify("Invitation", "Cette application n’est pas disponible sur cet appareil.");
    }
  }

  async function shareOrCopy() {
    try {
      if (Platform.OS === "web" && typeof navigator !== "undefined") {
        if (typeof navigator.share === "function") { await navigator.share({ title: "Invitation Appro+", text: message }); return; }
        await navigator.clipboard.writeText(message);
        notify("Invitation", "Message copié : collez-le dans l’application de votre choix.");
        return;
      }
      await Share.share({ message, title: "Invitation Appro+" });
    } catch {
      // Closed by the user.
    }
  }

  async function messenger() {
    if (Platform.OS === "web") {
      // Messenger cannot be pre-filled from a web page: the message is copied, then Messenger opens.
      try { await navigator.clipboard.writeText(message); } catch { /* not allowed */ }
      notify("Messenger", "Message copié : collez-le dans la conversation.");
      window.open("https://www.messenger.com/", "_blank");
      return;
    }
    await open(`fb-messenger://share/?link=${encodeURIComponent(link || message)}`);
  }

  const channels: { key: string; label: string; icon: keyof typeof Ionicons.glyphMap; color: string; onPress: () => void }[] = [
    { key: "whatsapp", label: "WhatsApp", icon: "logo-whatsapp", color: "#1f9d55", onPress: () => void open(`https://wa.me/${digits}?text=${encodeURIComponent(message)}`) },
    { key: "messenger", label: "Messenger", icon: "chatbubble-ellipses-outline", color: "#0866ff", onPress: () => void messenger() },
    { key: "sms", label: "SMS", icon: "chatbox-outline", color: colors.primary, onPress: () => void open(`sms:${phone.trim()}${Platform.OS === "ios" ? "&" : "?"}body=${encodeURIComponent(message)}`) },
    { key: "email", label: "E-mail", icon: "mail-outline", color: colors.primary, onPress: () => void open(`mailto:${email.trim()}?subject=${encodeURIComponent("Invitation Appro+")}&body=${encodeURIComponent(message)}`) },
    { key: "share", label: Platform.OS === "web" ? "Copier" : "Autre application", icon: Platform.OS === "web" ? "copy-outline" : "share-social-outline", color: colors.text, onPress: () => void shareOrCopy() },
  ];

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow={forOrgName ? `INVITATION POUR ${forOrgName.toLocaleUpperCase("fr")}` : "INVITATION"} title={side === "client" ? "Inviter un client" : "Inviter un fournisseur"} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <Text style={[ui.small, { marginTop: 8 }]}>{side === "client"
          ? "La personne installe Appro+ et crée son compte avec votre lien : elle devient votre client dès que son espace existe."
          : "Le fournisseur installe Appro+ et crée son espace avec votre lien : vous êtes aussitôt en relation."}</Text>
        <Field label="Nom (entreprise ou personne)" value={name} onChangeText={setName} placeholder="Facultatif" />
        <Field label="Téléphone (WhatsApp, SMS)" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Facultatif" />
        <Field label="E-mail" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" placeholder="Facultatif" />
        {!invitation ? <Button label="CRÉER L’INVITATION" onPress={() => create()} busy={busy} style={{ marginTop: 10 }} /> : null}
        {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
        {invitation ? <View style={[ui.card, { marginTop: 12 }]}>
          <Text style={ui.small}>Code d’invitation (valable 30 jours)</Text>
          <Text style={styles.code}>{invitation.code}</Text>
          {link ? <Text style={[ui.small, { color: colors.primary }]} selectable>{link}</Text>
            : <Text style={ui.small}>Lien web non configuré par Appro+ : la personne saisit le code dans l’application.</Text>}
          <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Envoyer par</Text>
          <View style={styles.channels}>
            {channels.map((item) => <Pressable key={item.key} onPress={item.onPress} style={({ pressed }) => [styles.channel, pressed && { opacity: 0.7 }]} accessibilityLabel={`Envoyer par ${item.label}`}>
              <Ionicons name={item.icon} size={22} color={item.color} />
              <Text style={styles.channelText}>{item.label}</Text>
            </Pressable>)}
          </View>
          <Text style={[ui.fieldLabel, { marginTop: 12 }]}>Message</Text>
          <Text style={[ui.body, styles.preview]} selectable>{message}</Text>
        </View> : null}
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}

const styles = StyleSheet.create({
  code: { color: colors.text, fontSize: 26, fontWeight: "800", letterSpacing: 4, marginVertical: 4 },
  channels: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 6 },
  channel: { width: 96, alignItems: "center", gap: 4, paddingVertical: 10, borderRadius: 12, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.white },
  channelText: { color: colors.text, fontSize: 12, fontWeight: "700" },
  preview: { backgroundColor: colors.cream, borderRadius: 8, padding: 10, marginTop: 4 },
});
