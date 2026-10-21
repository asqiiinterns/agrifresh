import type { IconName, TabKey } from "./navigation";

// Entries a role's bottom bar can show (Rôles et accès → a role → Barre du bas). Messages and notifications keep
// their icons at the top; « Plus » is always last. An entry the person has no right to is simply not shown.
export type MenuEntry = { key: TabKey; label: string; icon: IconName };

export const teamMenu: MenuEntry[] = [
  { key: "home", label: "Accueil", icon: "home-outline" },
  { key: "decide", label: "À décider", icon: "flag-outline" },
  { key: "orders", label: "Commandes", icon: "receipt-outline" },
  { key: "staffOrder", label: "Commander", icon: "add-circle-outline" },
  { key: "production", label: "Production", icon: "construct-outline" },
  { key: "planning", label: "Planning", icon: "list-outline" },
  { key: "deliveries", label: "Livraisons", icon: "car-outline" },
  { key: "invoices", label: "Factures", icon: "document-text-outline" },
  { key: "returns", label: "Retours et avoirs", icon: "return-down-back-outline" },
  { key: "calendar", label: "Calendrier", icon: "calendar-outline" },
  { key: "leaves", label: "Congés", icon: "airplane-outline" },
  { key: "incidents", label: "Incidents", icon: "warning-outline" },
  { key: "recurring", label: "Commandes récurrentes", icon: "repeat-outline" },
  { key: "stats", label: "Statistiques", icon: "stats-chart-outline" },
  { key: "network", label: "Réseau", icon: "git-network-outline" },
  { key: "admin", label: "Admin", icon: "settings-outline" },
];

export const customerMenu: MenuEntry[] = [
  { key: "home", label: "Accueil", icon: "home-outline" },
  { key: "order", label: "Commander", icon: "add-circle-outline" },
  { key: "orders", label: "Commandes", icon: "receipt-outline" },
  { key: "invoices", label: "Factures", icon: "document-text-outline" },
  { key: "recurring", label: "Commandes récurrentes", icon: "repeat-outline" },
  { key: "discover", label: "Découvrir", icon: "compass-outline" },
  { key: "network", label: "Réseau", icon: "git-network-outline" },
];
