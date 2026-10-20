import { useEffect, useMemo, useRef, useState } from "react";
import { Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text, TextInput } from "../ui/Text";
import { Button, Chip, CloseButton, ScreenHeader } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";

export type Recipient = { id: string; label: string };

// A new message to one or several recipients (suppliers for a buyer, clients for a supplier):
// recipients ticked first, then the text; one copy goes into each conversation.
export function ComposeModal({ visible, title, recipients, onClose, onSend }: {
  visible: boolean;
  title: string;
  recipients: Recipient[];
  onClose: () => void;
  onSend: (ids: string[], body: string) => Promise<unknown>;
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    setChosen(recipients.length === 1 ? [recipients[0].id] : []);
    setSearch("");
    setBody("");
    setError("");
  }, [visible]);

  const term = search.trim().toLocaleLowerCase("fr");
  const shown = useMemo(() => recipients.filter((item) => !term || item.label.toLocaleLowerCase("fr").includes(term)), [recipients, term]);
  const all = recipients.length > 0 && chosen.length === recipients.length;
  const toggle = (id: string) => setChosen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  async function send() {
    if (sending.current) return;
    if (!chosen.length) {
      setError("Choisissez au moins un destinataire.");
      return;
    }
    if (!body.trim()) {
      setError("Écrivez votre message.");
      return;
    }
    sending.current = true;
    setBusy(true);
    setError("");
    try {
      await onSend(chosen, body);
      notify("Message envoyé", chosen.length > 1 ? `Envoyé à ${chosen.length} destinataires, chacun dans sa conversation.` : "Votre message est envoyé.");
      onClose();
    } catch (cause) {
      setError(errorMessage(cause, "Le message n’a pas pu être envoyé."));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={ui.modalSafe}>
      <ScreenHeader eyebrow="NOUVEAU MESSAGE" title={title} right={<CloseButton onPress={onClose} />} />
      <ScrollView contentContainerStyle={ui.content} keyboardShouldPersistTaps="handled">
        <View style={ui.card}>
          <View style={ui.row}>
            <Text style={[ui.strong, { flex: 1 }]}>Destinataires</Text>
            <Text style={ui.small}>{`${chosen.length} / ${recipients.length}`}</Text>
          </View>
          {recipients.length > 6 ? <TextInput value={search} onChangeText={setSearch} placeholder="Rechercher" placeholderTextColor={colors.muted} style={[ui.input, { marginTop: 8 }]} /> : null}
          <View style={[ui.wrapRow, { marginTop: 10 }]}>
            {recipients.length > 1 ? <Chip label={all ? "✓ Tous" : "Tous"} selected={all} onPress={() => setChosen(all ? [] : recipients.map((item) => item.id))} /> : null}
            {shown.map((item) => <Chip key={item.id} label={chosen.includes(item.id) ? `✓ ${item.label}` : item.label} selected={chosen.includes(item.id)} onPress={() => toggle(item.id)} />)}
          </View>
          {chosen.length > 1 ? <Text style={[ui.small, { marginTop: 8 }]}>Chaque destinataire reçoit le message dans sa propre conversation : les autres ne le voient pas.</Text> : null}
        </View>
        <View style={ui.card}>
          <Text style={ui.strong}>Message</Text>
          <TextInput value={body} onChangeText={setBody} placeholder="Votre message…" placeholderTextColor={colors.muted} style={[ui.input, { minHeight: 120, textAlignVertical: "top", marginTop: 8 }]} multiline maxLength={2000} />
          <Text style={[ui.small, { marginTop: 6 }]}>Pour joindre un fichier, ouvrez la conversation d’un seul destinataire.</Text>
        </View>
        {error ? <Text style={[ui.error, { marginTop: 8 }]}>{error}</Text> : null}
        <Button label={chosen.length > 1 ? `ENVOYER À ${chosen.length} DESTINATAIRES` : "ENVOYER"} onPress={() => send()} busy={busy} style={{ marginTop: 14 }} />
      </ScrollView>
    </SafeAreaView>
  </Modal>;
}
