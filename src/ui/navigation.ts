import { createContext, useContext } from "react";
import type { ComponentProps } from "react";
import type { Ionicons } from "@expo/vector-icons";

export type TabKey = "home" | "decide" | "order" | "staffOrder" | "orders" | "planning" | "alerts" | "production" | "messages" | "clients" | "invoices" | "deliveries" | "admin" | "account" | "returns" | "calendar" | "leaves" | "incidents" | "stats" | "recurring" | "more" | "pros" | "platformTeam" | "platformSettings" | "network";
export type IconName = ComponentProps<typeof Ionicons>["name"];
export type TabDef = { key: TabKey; label: string; icon: IconName; description?: string };
// Opens a tab, optionally at a given section (e.g. Commandes → "À décider").
export type NavParams = { section?: string; page?: string; orderId?: string; back?: TabKey };

export const NavContext = createContext<{ navigate: (tab: TabKey, params?: NavParams) => void }>({ navigate: () => {} });
export const useNav = () => useContext(NavContext);
