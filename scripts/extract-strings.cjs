// Lists every user-facing French text of the app (string literals, JSX text, template literals
// with {0}, {1}… for their variables) so that src/ui/translations.ts can cover all of them.
// Usage: node scripts/extract-strings.cjs > strings.json
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const root = path.join(__dirname, "..");
const files = [];
(function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) walk(full);
    else if (/\.(tsx?|ts)$/.test(name) && !/i18n|translations/.test(full)) files.push(full);
  }
})(path.join(root, "src"));
files.push(path.join(root, "App.tsx"));

const looksFrench = (text) => {
  const t = text.trim();
  if (t.length < 2 || !/[A-Za-zÀ-ÿ]/.test(t)) return false;
  if (/^[a-z0-9_.\-/:#%@*,()]+$/i.test(t) && !/\s/.test(t) && !/[A-ZÀ-Ý]/.test(t[0])) return false;
  if (/^(https?:|select |id, |public\.|agrifresh-|rgba?\(|#[0-9a-f]{3,8}$)/i.test(t)) return false;
  if (/^[A-Z0-9_]+$/.test(t) && t.length < 3) return false;
  return true;
};
// Values that are code, not text: object keys, styles, imports, rpc/table names, keys of maps.
const codeContexts = new Set(["ImportDeclaration", "ExportDeclaration", "ExternalModuleReference", "LiteralType"]);
const ignoredProps = new Set(["key", "kind", "status", "tab", "section", "page", "icon", "name", "variant", "mode", "role", "audience", "need", "tone", "event",
  "keyboardType", "autoCapitalize", "presentationStyle", "animationType", "behavior", "barStyle", "accessibilityRole", "mimeType", "UTI", "contentType", "type",
  "textAlign", "fontWeight", "flexDirection", "alignItems", "justifyContent", "position", "borderStyle", "textTransform", "resizeMode", "facing", "method", "doc_type", "feature"]);

const statics = new Set();
const patterns = new Set();
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const visit = (node) => {
    if (codeContexts.has(ts.SyntaxKind[node.kind])) return;
    if (ts.isJsxText(node)) {
      const t = node.text.replace(/\s+/g, " ").trim();
      if (looksFrench(t)) statics.add(t);
    } else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const parent = node.parent;
      const prop = parent && (ts.isPropertyAssignment(parent) || ts.isJsxAttribute(parent)) && parent.initializer === node ? parent.name.getText(source) : null;
      const inCall = parent && ts.isCallExpression(parent) && /\.(rpc|from|select|eq|in|or|order|channel|on|getItem|setItem|removeItem|includes|toLocale\w+|startsWith|replace|split|join|padStart)$/.test(parent.expression.getText(source));
      const isComparison = parent && ts.isBinaryExpression(parent) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(parent.operatorToken.kind);
      const isIndex = parent && ts.isElementAccessExpression(parent);
      if (!(prop && ignoredProps.has(prop)) && !inCall && !isComparison && !isIndex && looksFrench(node.text) && !(ts.isPropertyAssignment(parent) && parent.name === node)) statics.add(node.text);
    } else if (ts.isTemplateExpression(node)) {
      let text = node.head.text;
      node.templateSpans.forEach((span, index) => { text += `{${index}}` + span.literal.text; });
      const bare = text.replace(/\{\d+\}/g, "").trim();
      if (looksFrench(bare) && /[A-Za-zÀ-ÿ]{2}/.test(bare) && !/<\w|\{0\}\{1\}/.test(text)) patterns.add(text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}
process.stdout.write(JSON.stringify({ static: [...statics].sort(), patterns: [...patterns].sort() }, null, 1));
