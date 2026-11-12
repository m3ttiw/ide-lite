import { StreamLanguage } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import type { LangId } from "../lib/lang";

// Every language pack is its own chunk, loaded the first time a file needs it.
const cache = new Map<LangId, Promise<Extension | null>>();

async function load(id: LangId): Promise<Extension | null> {
  switch (id) {
    case "rust":
      return (await import("@codemirror/lang-rust")).rust();
    case "javascript":
      return (await import("@codemirror/lang-javascript")).javascript();
    case "jsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true });
    case "typescript":
      return (await import("@codemirror/lang-javascript")).javascript({ typescript: true });
    case "tsx":
      return (await import("@codemirror/lang-javascript")).javascript({ jsx: true, typescript: true });
    case "json":
      return (await import("@codemirror/lang-json")).json();
    case "markdown":
      return (await import("@codemirror/lang-markdown")).markdown();
    case "html":
      return (await import("@codemirror/lang-html")).html();
    case "css":
      return (await import("@codemirror/lang-css")).css();
    case "python":
      return (await import("@codemirror/lang-python")).python();
    case "yaml":
      return (await import("@codemirror/lang-yaml")).yaml();
    case "toml":
      return StreamLanguage.define((await import("@codemirror/legacy-modes/mode/toml")).toml);
    default:
      return null;
  }
}

export function languageExtension(id: LangId): Promise<Extension | null> {
  let p = cache.get(id);
  if (!p) {
    p = load(id).catch(() => null);
    cache.set(id, p);
  }
  return p;
}
