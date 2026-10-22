import { useState } from "react";
import { View } from "react-native";
import { useCan } from "../data/permissions";
import { Sheets } from "../ui/components";
import { ui } from "../ui/theme";
import { PlanningTab } from "./PlanningScreen";
import { ProductionScreen } from "./ProductionScreen";
import { StaffOrdersScreen } from "./StaffOrdersScreen";

export type HubSheet = "orders" | "closed" | "prepare" | "planning";

// "Production" in the main menu: orders, quantities to prepare and the production queue, as sheets.
export function ProductionHub({ initialSheet, ordersSection, orderId }: { initialSheet?: HubSheet; ordersSection?: string; orderId?: string }) {
  const can = useCan();
  const sheets: { key: HubSheet; label: string }[] = [
    ...(can("orders.view") ? [{ key: "orders" as const, label: "En cours" }, { key: "closed" as const, label: "Clôturées" }] : []),
    ...(can("production.view") ? [{ key: "prepare" as const, label: "Production" }] : []),
    ...(can("orders.plan") ? [{ key: "planning" as const, label: "Planning" }] : []),
  ];
  // Opening "Commandes → Clôturées" from a shortcut lands on the closed sheet.
  const wanted = initialSheet === "orders" && ordersSection === "done" ? "closed" : initialSheet;
  const [sheet, setSheet] = useState<HubSheet>(sheets.some((item) => item.key === wanted) ? wanted! : sheets[0]?.key ?? "orders");

  return <View style={ui.screen}>
    {sheets.length > 1 ? <Sheets items={sheets} value={sheet} onChange={setSheet} /> : null}
    <View style={{ flex: 1 }}>
      {sheet === "orders" ? <StaffOrdersScreen key="open" mode="open" initialSection={ordersSection} initialOrderId={orderId} />
        : sheet === "closed" ? <StaffOrdersScreen key="closed" mode="closed" initialOrderId={orderId} />
        : sheet === "prepare" ? <ProductionScreen />
        : <PlanningTab />}
    </View>
  </View>;
}
