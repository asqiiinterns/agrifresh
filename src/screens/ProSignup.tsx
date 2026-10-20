import { useState } from "react";
import { Switch, View } from "react-native";
import { Text } from "../ui/Text";
import { registerPro, type MyPro } from "../data/pros";
import { Button, Field } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

// An account without a Pro creates its own (supplier, buyer or both); Appro+ validates it.
export function RegisterProCard({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [supplier, setSupplier] = useState(false);
  const [buyer, setBuyer] = useState(true);
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [taxId, setTaxId] = useState("");
  const [error, setError] = useState("");

  async function submit() {
    setError("");
    try {
      await registerPro({ name, is_supplier: supplier, is_buyer: buyer, phone, address, tax_id: taxId });
      onDone();
    } catch (cause) {
      setError(errorMessage(cause, "Votre espace Pro n’a pas pu être créé."));
    }
  }

  return <View style={ui.card}>
    <Text style={ui.strong}>Créer mon espace Pro</Text>
    <Text style={ui.small}>Vous êtes une entreprise ? Créez votre espace : il sera actif dès sa validation par l’équipe Appro+.</Text>
    <Field label="Nom de l’entreprise" value={name} onChangeText={setName} />
    <View style={[ui.row, { marginTop: 6 }]}>
      <Text style={[ui.body, { flex: 1 }]}>Je vends (fournisseur)</Text>
      <Switch value={supplier} onValueChange={setSupplier} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
    </View>
    <View style={[ui.row, { marginTop: 6 }]}>
      <Text style={[ui.body, { flex: 1 }]}>J’achète (acheteur)</Text>
      <Switch value={buyer} onValueChange={setBuyer} trackColor={{ true: colors.primary, false: colors.line }} thumbColor={colors.white} />
    </View>
    <Field label="Téléphone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" />
    <Field label="Adresse" value={address} onChangeText={setAddress} />
    <Field label="Matricule fiscal (facultatif)" value={taxId} onChangeText={setTaxId} autoCapitalize="characters" />
    {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
    <Button label="ENVOYER MA DEMANDE" disabled={name.trim().length < 2 || !(supplier || buyer)} onPress={() => submit()} style={{ marginTop: 10 }} />
  </View>;
}

export function ProPendingCard({ pro }: { pro: MyPro }) {
  return <View style={ui.card}>
    <Text style={ui.strong}>{pro.name}</Text>
    <Text style={ui.small}>{pro.status === "pending" ? "Votre espace Pro est en attente de validation par l’équipe Appro+. Vous serez prévenu dès son activation."
      : pro.status === "suspended" ? "Votre espace Pro est suspendu. Contactez l’équipe Appro+."
      : "Votre demande n’a pas été acceptée. Contactez l’équipe Appro+ si vous pensez qu’il s’agit d’une erreur."}</Text>
  </View>;
}
