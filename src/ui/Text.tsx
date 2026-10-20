import { Children, forwardRef, type ComponentProps, type ElementRef, type ReactNode } from "react";
import { translate, type Language } from "./i18n";
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

// Plain text pieces are translated into the chosen language (see i18n.ts).
const translated = (children: ReactNode, language: Language): ReactNode => language === "fr" ? children
  : Children.map(children, (child) => typeof child === "string" ? translate(child, language) : child);

export const Text = forwardRef<ElementRef<typeof NativeText>, ComponentProps<typeof NativeText>>(function Text(props, ref) {
  const { fontScale, language } = useDisplay();
  const style = scaled(props.style, fontScale);
  return <NativeText ref={ref} {...props} style={language === "ar" ? [style, { writingDirection: "rtl" }] : style}>{translated(props.children, language)}</NativeText>;
});

export const TextInput = forwardRef<ElementRef<typeof NativeTextInput>, ComponentProps<typeof NativeTextInput>>(function TextInput(props, ref) {
  const { fontScale, language } = useDisplay();
  return <NativeTextInput ref={ref} {...props} placeholder={props.placeholder ? translate(props.placeholder, language) : props.placeholder} style={scaled(props.style, fontScale)} />;
});
