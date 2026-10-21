import { useEffect, useState } from "react";
import { Modal, StyleSheet, View } from "react-native";
import { Text } from "./Text";
import { supabase } from "../lib/supabase";
import { Button, Field } from "./components";
import { colors, ui } from "./theme";

// Critical changes (rights, imports, assistance with changes…) ask the password of the signed-in person again.
type Pending = { reason: string; resolve: (ok: boolean) => void };
let listener: ((pending: Pending) => void) | null = null;

export function confirmWithPassword(reason: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (!listener || !supabase) { resolve(true); return; }
    listener({ reason, resolve });
  });
}

export function PasswordConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    listener = (next) => { setPending(next); setPassword(""); setError(""); };
    return () => { listener = null; };
  }, []);

  function close(ok: boolean) {
    pending?.resolve(ok);
    setPending(null);
  }

  async function check() {
    if (!supabase || !pending) return;
    setBusy(true);
    setError("");
    try {
      const { data } = await supabase.auth.getUser();
      const email = data.user?.email;
      if (!email) { close(false); return; }
      // Signing in again with the same account checks the password without changing anything else.
      const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
      if (authError) { setError("Mot de passe incorrect."); return; }
      close(true);
    } finally {
      setBusy(false);
    }
  }

  return <Modal visible={pending !== null} transparent animationType="fade" onRequestClose={() => close(false)}>
    <View style={styles.backdrop}>
      <View style={styles.box}>
        <Text style={ui.strong}>Confirmez avec votre mot de passe</Text>
        <Text style={[ui.small, { marginTop: 6 }]}>{pending?.reason}</Text>
        <Field label="Mot de passe" value={password} onChangeText={setPassword} secureTextEntry autoFocus onSubmitEditing={() => void check()} />
        {error ? <Text style={[ui.error, { marginTop: 6 }]}>{error}</Text> : null}
        <View style={[ui.wrapRow, { marginTop: 12, justifyContent: "flex-end" }]}>
          <Button label="ANNULER" variant="secondary" onPress={() => close(false)} disabled={busy} />
          <Button label="CONFIRMER" onPress={check} busy={busy} disabled={password.length < 1} />
        </View>
      </View>
    </View>
  </Modal>;
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(24,60,42,0.35)", alignItems: "center", justifyContent: "center", padding: 20 },
  box: { width: "100%", maxWidth: 420, backgroundColor: colors.white, borderRadius: 14, padding: 18 },
});
