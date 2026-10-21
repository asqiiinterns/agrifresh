import AsyncStorage from "@react-native-async-storage/async-storage";
import { Linking, Platform } from "react-native";

// The invitation code of the link that opened the app (…/?invite=CODE, or agrifresh://…?invite=CODE),
// kept until the person has signed in, then accepted (data/directory acceptInvitation).
const KEY = "appro-invite-code";
const listeners = new Set<(code: string | null) => void>();

const codeIn = (url: string | null | undefined) => url?.match(/[?&]invite=([A-Za-z0-9]{6,12})/)?.[1]?.toUpperCase() ?? null;

export async function setPendingInvite(code: string | null) {
  try {
    if (code) await AsyncStorage.setItem(KEY, code.trim().toUpperCase());
    else await AsyncStorage.removeItem(KEY);
  } catch {
    // Storage unavailable: the code can still be typed in the app.
  }
  listeners.forEach((listener) => listener(code));
}

export async function getPendingInvite(): Promise<string | null> {
  try { return await AsyncStorage.getItem(KEY); } catch { return null; }
}

export function onPendingInvite(listener: (code: string | null) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

// Reads the code once at start-up and from links opened while the app runs.
export function startInviteCapture(): () => void {
  if (Platform.OS === "web" && typeof window !== "undefined") {
    const code = codeIn(window.location.search);
    if (code) {
      void setPendingInvite(code);
      // The address bar is cleaned so a reload does not accept it twice.
      const url = new URL(window.location.href);
      url.searchParams.delete("invite");
      window.history.replaceState(null, "", url.toString());
    }
    return () => {};
  }
  void Linking.getInitialURL().then((url) => { const code = codeIn(url); if (code) void setPendingInvite(code); }).catch(() => {});
  const subscription = Linking.addEventListener("url", ({ url }) => { const code = codeIn(url); if (code) void setPendingInvite(code); });
  return () => subscription.remove();
}
