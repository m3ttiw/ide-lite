// Key sequences in Emacs notation ("C-x C-f", "M-x", "RET", "<up>") and a
// small, DOM-free dispatcher for multi-key sequences.

export interface KeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
  getModifierState?(key: string): boolean;
}

const SPECIAL: Record<string, string> = {
  Enter: "RET",
  Tab: "TAB",
  Escape: "ESC",
  Backspace: "DEL",
  " ": "SPC",
  Delete: "<delete>",
  Insert: "<insert>",
  ArrowUp: "<up>",
  ArrowDown: "<down>",
  ArrowLeft: "<left>",
  ArrowRight: "<right>",
  Home: "<home>",
  End: "<end>",
  PageUp: "<prior>",
  PageDown: "<next>",
};

const MODIFIER_KEYS = new Set([
  "Control", "Alt", "Shift", "Meta", "AltGraph", "CapsLock", "OS", "Dead",
  "Process", "Unidentified", "Hyper", "Super", "NumLock", "ScrollLock", "Fn",
]);

/** Normalizes a keyboard event to one Emacs-notation key, or null for bare modifiers. */
export function eventToKey(e: KeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;
  let ctrl = e.ctrlKey;
  let alt = e.altKey;
  let shift = e.shiftKey;
  const meta = e.metaKey;
  // AltGr (Ctrl+Alt on Windows) types characters such as @ [ ] on Italian
  // layouts: those are plain characters, not chords.
  if (e.getModifierState?.("AltGraph")) {
    ctrl = false;
    alt = false;
  }
  const chord = ctrl || alt || meta;
  let base: string;
  if (e.key in SPECIAL) {
    base = SPECIAL[e.key];
    if (base === "SPC" && !chord) return "SPC";
  } else if (/^F\d{1,2}$/.test(e.key)) {
    base = `<${e.key.toLowerCase()}>`;
  } else if ([...e.key].length === 1) {
    let k = e.key;
    // Layout-independent letters for chords (Alt+F on some layouts types ƒ).
    if (chord && e.code && /^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
    if (/^[a-zA-Z]$/.test(k)) {
      if (!chord) return e.key;
      base = k.toLowerCase();
    } else {
      if (!chord) return k;
      base = k;
      shift = false; // shifted punctuation: the shift is part of the character
    }
  } else {
    return null;
  }
  return (ctrl ? "C-" : "") + (alt ? "M-" : "") + (meta ? "s-" : "") + (shift ? "S-" : "") + base;
}

export function parseSeq(seq: string): string[] {
  return seq.trim().split(/\s+/).filter(Boolean);
}

/** "C-x C-f" -> CodeMirror key names ("Ctrl-x Ctrl-f"). */
export function toCodeMirrorKey(seq: string): string {
  return parseSeq(seq)
    .map((k) => {
      const mods: string[] = [];
      let rest = k;
      while (/^[CMsS]-./.test(rest)) {
        const m = rest[0];
        mods.push(m === "C" ? "Ctrl" : m === "M" ? "Alt" : m === "s" ? "Meta" : "Shift");
        rest = rest.slice(2);
      }
      const names: Record<string, string> = {
        RET: "Enter", TAB: "Tab", ESC: "Escape", DEL: "Backspace", SPC: "Space",
        "<delete>": "Delete", "<up>": "ArrowUp", "<down>": "ArrowDown", "<left>": "ArrowLeft",
        "<right>": "ArrowRight", "<home>": "Home", "<end>": "End", "<prior>": "PageUp", "<next>": "PageDown",
      };
      let name = names[rest] ?? rest;
      const f = /^<f(\d+)>$/.exec(rest);
      if (f) name = `F${f[1]}`;
      return [...mods, name].join("-");
    })
    .join(" ");
}

export interface Binding {
  /** Emacs-notation sequence, e.g. "C-x C-f". */
  keys: string;
  command: string;
  context: string;
}

export type FeedResult =
  | { kind: "command"; command: string; binding: Binding }
  | { kind: "prefix"; pending: string[] }
  | { kind: "cancel" }
  | { kind: "undefined"; seq: string[] }
  | { kind: "pass" };

/**
 * Resolves keys against a binding table. `contexts` is ordered from the most
 * specific to the most general; the first context that knows the sequence
 * (or a longer sequence starting with it) wins.
 */
export class Dispatcher {
  pending: string[] = [];
  private exact = new Map<string, Binding>();
  private prefixes = new Set<string>();

  constructor(bindings: Binding[], readonly cancelKey = "C-g") {
    this.setBindings(bindings);
  }

  setBindings(bindings: Binding[]): void {
    this.exact.clear();
    this.prefixes.clear();
    this.pending = [];
    for (const b of bindings) {
      const seq = parseSeq(b.keys);
      const id = `${b.context}\u0000${seq.join(" ")}`;
      if (!this.exact.has(id)) this.exact.set(id, b);
      for (let i = 1; i < seq.length; i++) this.prefixes.add(`${b.context}\u0000${seq.slice(0, i).join(" ")}`);
    }
  }

  reset(): void {
    this.pending = [];
  }

  feed(key: string, contexts: string[]): FeedResult {
    if (this.pending.length > 0 && key === this.cancelKey) {
      this.pending = [];
      return { kind: "cancel" };
    }
    const seq = [...this.pending, key];
    const s = seq.join(" ");
    for (const ctx of contexts) {
      const b = this.exact.get(`${ctx}\u0000${s}`);
      if (b) {
        this.pending = [];
        return { kind: "command", command: b.command, binding: b };
      }
      if (this.prefixes.has(`${ctx}\u0000${s}`)) {
        this.pending = seq;
        return { kind: "prefix", pending: seq };
      }
    }
    if (this.pending.length > 0) {
      this.pending = [];
      return { kind: "undefined", seq };
    }
    return { kind: "pass" };
  }
}

/** All bindings that continue `pending`, first context winning on duplicates. */
export function continuations(bindings: Binding[], pending: string[], contexts: string[]): { rest: string; binding: Binding }[] {
  const prefix = pending.join(" ") + " ";
  const seen = new Set<string>();
  const out: { rest: string; binding: Binding }[] = [];
  for (const ctx of contexts) {
    for (const b of bindings) {
      if (b.context !== ctx) continue;
      const k = parseSeq(b.keys).join(" ");
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (seen.has(rest)) continue;
      seen.add(rest);
      out.push({ rest, binding: b });
    }
  }
  return out;
}
