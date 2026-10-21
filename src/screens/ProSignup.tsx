import { useState } from "react";
import { Modal, Switch, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "../ui/Text";
import { registerPro, type MyPro, type ProKind } from "../data/pros";
import { acceptInvitation } from "../data/directory";
import { setPendingInvite } from "../data/invite";
import { Button, Chip, CloseButton, Field, formatDateTime } from "../ui/components";
import { errorMessage, notify } from "../ui/notify";
import { colors, ui } from "../ui/theme";
import { PublicCatalogScreen } from "./PublicCatalogScreen";

// An account without a space creates its own: a business (supplier, buyer or both) or a private person
// (buyer). Appro+ validates it; when Appro+ allows a trial, it is active at once for that time.
export function RegisterProCard({ onDone, trialHours = 0 }: { onDone: () => void; trialHours?: number }) {
  const [kind, setKind] = useState<ProKind>("business");
  const [name, setName] = useState("");
  const [supplier, setSupplier] = useState(false);
  const [buyer, setBuyer] = useState(true);
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [error, setError] = useState("");
  const person = kind === "person";

  async function submit() {
    setError("");
    try {
      await registerPro({ name, kind, is_supplier: !person && supplier, is_buyer: person || buyer, phone, address, tax_id: person ? "" : taxId });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Votre espace n’a pas pu être créé."));
    }
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Créer mon espace</Text>
    <Text style={ui.small}>{trialHours > 0
      ? `Votre espace est actif tout de suite pendant ${trialHours} h, le temps que l’équipe Appro+ le valide.`
      : "Il sera actif dès sa validation par l’équipe Appro+. En attendant, vous pouvez parcourir les produits."}</Text>
    <View style={[ui.wrapRow, { marginTop: 8 }]}>
      <Chip label="Entreprise" selected={!person} onPress={() => setKind("business")} />
      <Chip label="Particulier" selected={person} onPress={() => setKind("person")} />
    </View>
    <Field label={person ? "Nom et prénom" : "Nom de l’entreprise"} value={name} onChangeText={setName} />
    {!person ? <>
      <View style={[ui.row, { marginTop: 6 }]}>
        <Text style={[ui.body, { flex: 1 }]}>Je vends (fournisseur)</Text>
        <Switch value={supplier} onValueChange={setSupplier} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
      </View>
      <View style={[ui.row, { marginTop: 6 }]}>
        <Text style={[ui.body, { flex: 1 }]}>J’achète (acheteur)</Text>
        <Switch value={buyer} onValueChange={setBuyer} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
      </View>
    </> : null}
    <Field label="Téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
    <Field label={person ? "Adresse de livraison" : "Adresse"} value={address} onChangeText={setAddress} />
    {!person ? <Field label="Matricule fiscal (facultatif)" value={taxId} onChangeText={setTaxId} autoCapitalize="characters" /> : null}
    {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
    <Button label={trialHours > 0 ? "CRÉER MON ESPACE" : "ENVOYER MA DEMANDE"} disabled={name.trim().length < 2 || (!person && !(supplier || buyer))} onPress={() => submit()} style={{ marginTop: 10 }} />
  </View>;
}

export function ProPendingCard({ pro }: { pro: MyPro }) {
  const trialOver = pro.status === "suspended" && !!pro.trial_until;
  return <View style={ui.card}>
    <Text style={ui.strong}>{pro.name}</Text>
    <Text style={ui.small}>{pro.status === "pending" ? "Votre espace est en attente de validation par l’équipe Appro+. Vous serez prévenu dès son activation. En attendant, vous pouvez parcourir les produits des fournisseurs."
      : trialOver ? `Votre période d’essai s’est terminée le ${formatDateTime(pro.trial_until!)}. Votre espace sera réactivé dès sa validation par l’équipe Appro+.`
      : pro.status === "suspended" ? "Votre espace est suspendu. Contactez l’équipe Appro+."
      : "Votre demande n’a pas été acceptée. Contactez l’équipe Appro+ si vous pensez qu’il s’agit d’une erreur."}</Text>
  </View>;
}

// "J'ai un code d'invitation": the code received by WhatsApp, SMS… when the link was not opened.
export function InviteCodeCard({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      const result = await acceptInvitation(code);
      await setPendingInvite(null);
      notify("Invitation", result.linked ? `Vous êtes maintenant en relation avec ${result.org_name}.`
        : result.needs_space ? `Invitation de ${result.org_name} enregistrée : créez votre espace ci-dessous, la relation se fera aussitôt.`
        : `Invitation de ${result.org_name} enregistrée.`);
      setCode("");
      onDone();
    } catch (cause) {
      notify("Invitation", errorMessage(cause, "Ce code n’a pas pu être utilisé."));
    } finally {
      setBusy(false);
    }
  }
  return <View style={ui.card}>
    <Text style={ui.strong}>J’ai un code d’invitation</Text>
    <Field label="Code reçu" value={code} onChangeText={(text) => setCode(text.toUpperCase())} autoCapitalize="characters" placeholder="Ex. 7994DE11" />
    <Button label="UTILISER CE CODE" onPress={submit} busy={busy} disabled={code.trim().length < 6} style={{ marginTop: 8 }} />
  </View>;
}

// Browsing the public catalogue before the account can order.
export function BrowseCatalogButton({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  return <>
    <Button label="VOIR LES PRODUITS DES FOURNISSEURS" variant="secondary" onPress={() => setOpen(true)} style={{ marginTop: 10 }} />
    <Modal visible={open} animationType="slide" onRequestClose={() => setOpen(false)}>
      <SafeAreaView style={ui.modalSafe}>
        <PublicCatalogScreen canOrder={false} reason={reason} header={<CloseButton onPress={() => setOpen(false)} />} />
      </SafeAreaView>
    </Modal>
  </>;
}
