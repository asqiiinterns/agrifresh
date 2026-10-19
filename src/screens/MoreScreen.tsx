import { ScrollView, View } from "react-native";
import { ListGroup, ListRow, ScreenHeader } from "../ui/components";
import { useNav, type TabDef } from "../ui/navigation";
import { ui } from "../ui/theme";

// "Plus": every section that does not fit in the bottom bar, as a compact list.
export function MoreScreen({ items, badges }: { items: TabDef[]; badges: Partial<Record<string, number>> }) {
  const { navigate } = useNav();
  return <View style={ui.screen}>
    <ScreenHeader eyebrow="TOUTES LES RUBRIQUES" title="Plus" />
    <ScrollView contentContainerStyle={ui.content}>
      <ListGroup>
        {items.map((item) => <ListRow key={item.key} icon={item.icon} title={item.label} detail={item.description} badge={badges[item.key]} onPress={() => navigate(item.key)} />)}
      </ListGroup>
    </ScrollView>
  </View>;
}
