import { basename, extname } from "./path";

export type LangId =
  | "rust" | "javascript" | "jsx" | "typescript" | "tsx" | "json" | "markdown"
  | "html" | "css" | "python" | "toml" | "yaml" | "text";

const BY_EXT: Record<string, LangId> = {
  rs: "rust",
  js: "javascript", mjs: "javascript", cjs: "javascript",
  jsx: "jsx",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  json: "json", jsonc: "json",
  md: "markdown", markdown: "markdown",
  html: "html", htm: "html", svg: "html", xml: "html",
  css: "css",
  py: "python", pyw: "python",
  toml: "toml",
  yaml: "yaml", yml: "yaml",
};

export function langOf(path: string): LangId {
  const name = basename(path);
  if (name === "Cargo.lock") return "toml";
  return BY_EXT[extname(path)] ?? "text";
}

export const LANG_NAMES: Record<LangId, string> = {
  rust: "Rust",
  javascript: "JavaScript",
  jsx: "JavaScript JSX",
  typescript: "TypeScript",
  tsx: "TypeScript JSX",
  json: "JSON",
  markdown: "Markdown",
  html: "HTML",
  css: "CSS",
  python: "Python",
  toml: "TOML",
  yaml: "YAML",
  text: "Testo",
};
