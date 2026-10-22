import { Component, type ErrorInfo, type ReactNode } from "react";
import { ScrollView, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Text } from "./Text";
import { Button } from "./components";
import { colors, ui } from "./theme";
import { reportError } from "../data/errors";

// A screen that crashes shows this card (and is reported to Appro+) instead of a white page.
type Props = { screen: string; children: ReactNode; onHome?: () => void };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    reportError({ screen: this.props.screen, kind: "render", message: `${error.name}: ${error.message}`, stack: error.stack ?? null, component_stack: info.componentStack ?? null });
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ScrollView contentContainerStyle={[ui.content, { alignItems: "center", paddingTop: 40 }]}>
      <Ionicons name="alert-circle-outline" size={44} color={colors.danger} />
      <Text style={[ui.strong, { marginTop: 10, textAlign: "center" }]}>Cet écran a rencontré un problème</Text>
      <Text style={[ui.small, { marginTop: 6, textAlign: "center" }]}>L’erreur a été transmise à l’équipe Appro+. Vous pouvez réessayer ou revenir à l’accueil ; le reste de l’application fonctionne.</Text>
      <View style={[ui.wrapRow, { marginTop: 14, justifyContent: "center" }]}>
        <Button label="RÉESSAYER" onPress={() => this.setState({ error: null })} />
        {this.props.onHome ? <Button label="RETOUR À L’ACCUEIL" variant="secondary" onPress={() => { this.setState({ error: null }); this.props.onHome?.(); }} /> : null}
      </View>
      <Text style={[ui.small, { marginTop: 18, color: colors.muted, textAlign: "center" }]} selectable>{`${this.props.screen} · ${error.name}: ${error.message}`}</Text>
    </ScrollView>;
  }
}
