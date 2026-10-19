import { createContext, useContext } from "react";
import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";

export type TabKey = "home" | "order" | "staffOrder" | "orders" | "planning" | "alerts" | "production" | "messages" | "clients" | "invoices" | "deliveries" | "admin" | "account" | "more";
export type IconName = ComponentProps<typeof Ionicons>["name"];
export type TabDef = { key: TabKey; label: string; icon: IconName; description?: string };
// Opens a tab, optionally at a given section (e.g. Commandes → "À décider").
export type NavParams = { section?: string; page?: string };

export const NavContext = createContext<{ navigate: (tab: TabKey, params?: NavParams) => void }>({ navigate: () => {} });
export const useNav = () => useContext(NavContext);
