import { For, type JSX } from "solid-js";
import { KEYMAPS, keyFor } from "../core/keymaps";
import { ui } from "../state/ui";

export const Kbd = (props: { children: JSX.Element }) => <kbd class="key">{props.children}</kbd>;

/** Binding of a command in the active keymap, or null. */
export function keyOf(command: string, contexts: string[] = ["global"]): string | null {
  return keyFor(KEYMAPS[ui.mode], command, contexts);
}

/** Text with the matched characters (indices from `offset`) emphasised. */
export function Highlight(props: { text: string; positions?: number[]; offset?: number }): JSX.Element {
  const parts = () => {
    const pos = props.positions;
    const off = props.offset ?? 0;
    if (!pos?.length) return [{ t: props.text, m: false }];
    const set = new Set(pos.map((p) => p - off));
    const out: { t: string; m: boolean }[] = [];
    for (let i = 0; i < props.text.length; i++) {
      const m = set.has(i);
      const last = out[out.length - 1];
      if (last && last.m === m) last.t += props.text[i];
      else out.push({ t: props.text[i], m });
    }
    return out;
  };
  return <For each={parts()}>{(p) => (p.m ? <mark class="hl">{p.t}</mark> : p.t)}</For>;
}

export const STATUS_CLASS: Record<string, string> = { M: "st-m", A: "st-a", D: "st-d", R: "st-r", C: "st-r", U: "st-u", "?": "st-q" };

export const LANE_COLORS = ["#e8b04a", "#7cc4e8", "#c79bf2", "#7fd18b", "#f09090", "#e8c37a", "#6aa7ff", "#d78bd0"];
