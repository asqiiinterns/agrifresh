import { useEffect, useRef } from "react";
import { BackHandler, Platform } from "react-native";
import { notify } from "./notify";

// Changes not saved yet on a page: leaving it (another tab, the phone's back button, closing the browser tab)
// asks first: go back to the page, save, or discard the changes.
type Guard = { message: string; save: () => Promise<boolean>; discard: () => void };
let current: Guard | null = null;

// Runs `proceed` at once when nothing is pending, otherwise after the person chose.
export function guardedLeave(proceed: () => void) {
  const guard = current;
  if (!guard) { proceed(); return; }
  notify("Modifications non enregistrées", guard.message, [
    { text: "Retour à la page", style: "cancel" },
    { text: "Abandonner", style: "destructive", onPress: () => { guard.discard(); current = null; proceed(); } },
    { text: "Enregistrer", onPress: () => void guard.save().then((saved) => { if (saved) { current = null; proceed(); } }) },
  ]);
}

export function useUnsavedChanges(dirty: boolean, save: () => Promise<boolean>, discard: () => void, message = "Vous avez des modifications qui ne sont pas encore enregistrées.") {
  const latest = useRef<Guard>({ message, save, discard });
  latest.current = { message, save, discard };

  useEffect(() => {
    if (!dirty) return;
    const guard: Guard = { message, save: () => latest.current.save(), discard: () => latest.current.discard() };
    current = guard;
    // Web: closing or reloading the tab.
    const onBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    if (Platform.OS === "web" && typeof window !== "undefined") window.addEventListener("beforeunload", onBeforeUnload);
    // Android: the back button.
    const back = Platform.OS === "android" ? BackHandler.addEventListener("hardwareBackPress", () => { guardedLeave(() => undefined); return true; }) : null;
    return () => {
      if (current === guard) current = null;
      if (Platform.OS === "web" && typeof window !== "undefined") window.removeEventListener("beforeunload", onBeforeUnload);
      back?.remove();
    };
  }, [dirty, message]);
}
