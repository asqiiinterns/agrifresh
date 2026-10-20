import { supabase } from "../lib/supabase";
import { unregisterPush } from "../notifications";
import { notify } from "./notify";

// Sign out from anywhere (top bar, bottom of Plus), after a confirmation.
export function confirmSignOut() {
  notify("Se déconnecter", "Voulez-vous vous déconnecter d’Appro+ ?", [
    { text: "Annuler", style: "cancel" },
    { text: "Se déconnecter", style: "destructive", onPress: () => {
      void (async () => {
        await unregisterPush().catch(() => {});
        await supabase?.auth.signOut();
      })();
    } },
  ]);
}
