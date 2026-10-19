import { forwardRef, type ComponentProps, type ElementRef } from "react";
import { Text as NativeText, TextInput as NativeTextInput, StyleSheet } from "react-native";
import { useDisplay } from "./display";

// Text and inputs of the whole app go through these so the text size chosen in
// Compte → Affichage applies everywhere.
function scaled<T>(style: T, scale: number): T {
  if (scale === 1 || !style) return style;
  const flat = StyleSheet.flatten(style as never) as { fontSize?: number; lineHeight?: number } | undefined;
  if (!flat || (flat.fontSize === undefined && flat.lineHeight === undefined)) return style;
  return [style, {
    ...(flat.fontSize !== undefined ? { fontSize: Math.round(flat.fontSize * scale * 10) / 10 } : {}),
    ...(flat.lineHeight !== undefined ? { lineHeight: Math.round(flat.lineHeight * scale) } : {}),
  }] as T;
}

export const Text = forwardRef<ElementRef<typeof NativeText>, ComponentProps<typeof NativeText>>(function Text(props, ref) {
  const { fontScale } = useDisplay();
  return <NativeText ref={ref} {...props} style={scaled(props.style, fontScale)} />;
});

export const TextInput = forwardRef<ElementRef<typeof NativeTextInput>, ComponentProps<typeof NativeTextInput>>(function TextInput(props, ref) {
  const { fontScale } = useDisplay();
  return <NativeTextInput ref={ref} {...props} style={scaled(props.style, fontScale)} />;
});
