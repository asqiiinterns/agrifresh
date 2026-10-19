import { createElement } from "react";

// Web preview: the document rendered in an isolated iframe.
export function DocumentFrame({ html }: { html: string }) {
  return createElement("iframe", {
    srcDoc: html,
    title: "Aperçu du document",
    style: { flex: 1, width: "100%", height: "100%", border: "none", backgroundColor: "#ffffff" },
  });
}
