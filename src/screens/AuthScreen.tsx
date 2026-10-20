import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { supabase } from "../lib/supabase";
import { Button, Chip, Field } from "../ui/components";
import { errorMessage } from "../ui/notify";
import { colors, ui } from "../ui/theme";

export const authRedirectUrl = () => Platform.OS === "web" && typeof window !== "undefined"
  ? window.location.origin
  : "agrifresh://auth/callback";

type Mode = "signin" | "activate" | "reset";

export function AuthScreen() {
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  function switchMode(next: Mode) {
    setMode(next);
    setMessage("");
    setError("");
  }

  async function submit() {
    if (!supabase) return;
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail || (mode !== "reset" && password.length < 8)) {
      setError(mode === "reset" ? "Saisissez votre adresse e-mail." : "Saisissez votre e-mail et un mot de passe d’au moins 8 caractères.");
      return;
    }
    setBusy(true); setMessage(""); setError("");
    try {
      if (mode === "signin") {
        const { error: authError } = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (authError) throw authError;
      } else if (mode === "activate") {
        const { data, error: authError } = await supabase.auth.signUp({ email: cleanEmail, password, options: { emailRedirectTo: authRedirectUrl() } });
        if (authError) throw authError;
        setMessage(data.session ? "Compte créé : il est en attente de validation par AgriFresh." : "Compte créé. Consultez votre boîte e-mail pour confirmer votre adresse, puis attendez la validation d’AgriFresh.");
      } else {
        const { error: authError } = await supabase.auth.resetPasswordForEmail(cleanEmail, { redirectTo: authRedirectUrl() });
        if (authError) throw authError;
        setMessage("Si ce compte existe, un e-mail vient d’être envoyé. Le lien vous connectera : choisissez ensuite un nouveau mot de passe dans Compte.");
      }
    } catch (cause) {
      setError(errorMessage(cause, "Une erreur est survenue."));
    } finally {
      setBusy(false);
    }
  }

  return <KeyboardAvoidingView style={ui.screen} behavior={Platform.OS === "ios" ? "padding" : undefined}>
    <ScrollView contentContainerStyle={[ui.content, { paddingTop: 40, maxWidth: 520, width: "100%", alignSelf: "center" }]} keyboardShouldPersistTaps="handled">
      <View style={{ alignItems: "center", marginBottom: 26 }}>
        <Text style={{ color: colors.dark, fontSize: 34, fontWeight: "800", letterSpacing: -1 }}>agri<Text style={{ color: colors.orange }}>fresh</Text></Text>
        <Text style={[ui.eyebrow, { marginTop: 4 }]}>ESPACE COMMANDES PROFESSIONNELLES</Text>
      </View>

      <View style={[ui.wrapRow, { justifyContent: "center" }]}>
        <Chip label="Connexion" selected={mode === "signin"} onPress={() => switchMode("signin")} />
        <Chip label="Créer mon compte" selected={mode === "activate"} onPress={() => switchMode("activate")} />
      </View>

      <Text style={[ui.subtitle, { textAlign: "center", marginTop: 16 }]}>
        {mode === "signin" ? "Connectez-vous pour passer et suivre vos commandes."
          : mode === "activate" ? "Utilisez l’adresse e-mail communiquée à AgriFresh. Votre compte sera actif dès qu’AgriFresh l’aura validé."
          : "Recevez un lien de connexion pour choisir un nouveau mot de passe."}
      </Text>

      <Field label="Adresse e-mail" value={email} onChangeText={setEmail} keyboardType="email-address" autoCapitalize="none" autoComplete="email" />
      {mode !== "reset" ? <Field label={mode === "activate" ? "Choisissez un mot de passe (8 caractères minimum)" : "Mot de passe"} value={password} onChangeText={setPassword} secureTextEntry onSubmitEditing={() => void submit()} /> : null}

      <View style={{ marginTop: 16, gap: 10 }}>
        {message ? <Text style={ui.success}>{message}</Text> : null}
        {error ? <Text style={ui.error}>{error}</Text> : null}
        <Button label={mode === "signin" ? "SE CONNECTER" : mode === "activate" ? "CRÉER MON COMPTE" : "ENVOYER LE LIEN"} onPress={() => submit()} busy={busy} />
        {mode === "signin" ? <Button label="Mot de passe oublié ?" variant="secondary" onPress={() => switchMode("reset")} />
          : mode === "reset" ? <Button label="Retour à la connexion" variant="secondary" onPress={() => switchMode("signin")} /> : null}
      </View>
    </ScrollView>
  </KeyboardAvoidingView>;
}
