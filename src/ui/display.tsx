import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";

// Per-device display preferences, set in Compte → Affichage.
import type { Language } from "./i18n";

export type DisplaySettings = { fontScale: number; compactProducts: boolean; language: Language };

export const fontScales = [
  { value: 0.9, label: "Petite" },
  { value: 1, label: "Normale" },
  { value: 1.15, label: "Grande" },
  { value: 1.3, label: "Très grande" },
];

const DEFAULTS: DisplaySettings = { fontScale: 1, compactProducts: false, language: "fr" };
const STORAGE_KEY = "agrifresh-display";

type DisplayContextValue = DisplaySettings & { update: (patch: Partial<DisplaySettings>) => void; reset: () => void };

const DisplayContext = createContext<DisplayContextValue>({ ...DEFAULTS, update: () => {}, reset: () => {} });

export function DisplayProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<DisplaySettings>(DEFAULTS);

  useEffect(() => {
    void AsyncStorage.getItem(STORAGE_KEY)
      .then((stored) => { if (stored) setSettings({ ...DEFAULTS, ...(JSON.parse(stored) as Partial<DisplaySettings>) }); })
      .catch(() => {});
  }, []);

  const value = useMemo<DisplayContextValue>(() => {
    const save = (next: DisplaySettings) => {
      setSettings(next);
      void AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next)).catch(() => {});
    };
    return { ...settings, update: (patch) => save({ ...settings, ...patch }), reset: () => save(DEFAULTS) };
  }, [settings]);

  return <DisplayContext.Provider value={value}>{children}</DisplayContext.Provider>;
}

export const useDisplay = () => useContext(DisplayContext);
