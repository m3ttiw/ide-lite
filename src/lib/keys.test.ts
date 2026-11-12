import { describe, expect, it } from "vitest";
import { Dispatcher, continuations, eventToKey, parseSeq, toCodeMirrorKey, type Binding } from "./keys";

const ev = (key: string, mods: Partial<{ ctrl: boolean; alt: boolean; shift: boolean; meta: boolean; code: string; altGr: boolean }> = {}) => ({
  key,
  code: mods.code,
  ctrlKey: !!mods.ctrl,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift,
  metaKey: !!mods.meta,
  getModifierState: (k: string) => k === "AltGraph" && !!mods.altGr,
});

describe("eventToKey", () => {
  it("names chords in Emacs notation", () => {
    expect(eventToKey(ev("x", { ctrl: true }))).toBe("C-x");
    expect(eventToKey(ev("x", { alt: true }))).toBe("M-x");
    expect(eventToKey(ev("P", { ctrl: true, shift: true }))).toBe("C-S-p");
    expect(eventToKey(ev(" ", { ctrl: true }))).toBe("C-SPC");
    expect(eventToKey(ev("Enter"))).toBe("RET");
    expect(eventToKey(ev("ArrowDown"))).toBe("<down>");
    expect(eventToKey(ev("Tab", { ctrl: true }))).toBe("C-TAB");
    expect(eventToKey(ev("F5"))).toBe("<f5>");
  });

  it("keeps shifted punctuation as a character", () => {
    expect(eventToKey(ev("<", { alt: true }))).toBe("M-<");
    expect(eventToKey(ev(">", { alt: true, shift: true }))).toBe("M->");
    expect(eventToKey(ev("/", { ctrl: true, shift: true }))).toBe("C-/");
  });

  it("plain characters are returned as typed", () => {
    expect(eventToKey(ev("n"))).toBe("n");
    expect(eventToKey(ev("N", { shift: true }))).toBe("N");
    expect(eventToKey(ev("1"))).toBe("1");
  });

  it("ignores bare modifiers and treats AltGr as typing", () => {
    expect(eventToKey(ev("Control", { ctrl: true }))).toBeNull();
    expect(eventToKey(ev("@", { ctrl: true, alt: true, altGr: true }))).toBe("@");
  });

  it("uses the physical letter for chords", () => {
    expect(eventToKey(ev("ƒ", { alt: true, code: "KeyF" }))).toBe("M-f");
  });
});

describe("toCodeMirrorKey", () => {
  it("converts to CodeMirror names", () => {
    expect(toCodeMirrorKey("C-a")).toBe("Ctrl-a");
    expect(toCodeMirrorKey("M-<")).toBe("Alt-<");
    expect(toCodeMirrorKey("C-SPC")).toBe("Ctrl-Space");
    expect(toCodeMirrorKey("C-S-z")).toBe("Ctrl-Shift-z");
    expect(toCodeMirrorKey("C-x C-s")).toBe("Ctrl-x Ctrl-s");
    expect(toCodeMirrorKey("<f3>")).toBe("F3");
  });
});

describe("Dispatcher", () => {
  const bindings: Binding[] = [
    { keys: "C-x C-f", command: "open", context: "global" },
    { keys: "C-x C-s", command: "save", context: "global" },
    { keys: "C-x b", command: "buffers", context: "global" },
    { keys: "M-x", command: "palette", context: "global" },
    { keys: "C-g", command: "cancel", context: "global" },
    { keys: "C-n", command: "tree.next", context: "tree" },
    { keys: "C-n", command: "picker.next", context: "picker" },
    { keys: "C-a", command: "editor.lineStart", context: "editor" },
  ];

  it("parses sequences", () => {
    expect(parseSeq("  C-x   C-f ")).toEqual(["C-x", "C-f"]);
  });

  it("runs single-key bindings", () => {
    const d = new Dispatcher(bindings);
    expect(d.feed("M-x", ["global"])).toMatchObject({ kind: "command", command: "palette" });
  });

  it("handles a prefix and its continuation", () => {
    const d = new Dispatcher(bindings);
    expect(d.feed("C-x", ["global"])).toEqual({ kind: "prefix", pending: ["C-x"] });
    expect(d.pending).toEqual(["C-x"]);
    expect(d.feed("C-s", ["global"])).toMatchObject({ kind: "command", command: "save" });
    expect(d.pending).toEqual([]);
  });

  it("C-g cancels a pending prefix; otherwise it is a normal binding", () => {
    const d = new Dispatcher(bindings);
    d.feed("C-x", ["global"]);
    expect(d.feed("C-g", ["global"])).toEqual({ kind: "cancel" });
    expect(d.pending).toEqual([]);
    expect(d.feed("C-g", ["global"])).toMatchObject({ kind: "command", command: "cancel" });
  });

  it("reports an unbound continuation and resets", () => {
    const d = new Dispatcher(bindings);
    d.feed("C-x", ["global"]);
    expect(d.feed("z", ["global"])).toEqual({ kind: "undefined", seq: ["C-x", "z"] });
    expect(d.pending).toEqual([]);
  });

  it("passes unbound keys through", () => {
    const d = new Dispatcher(bindings);
    expect(d.feed("a", ["global"])).toEqual({ kind: "pass" });
    expect(d.feed("C-n", ["editor", "global"])).toEqual({ kind: "pass" });
  });

  it("the most specific context wins", () => {
    const d = new Dispatcher(bindings);
    expect(d.feed("C-n", ["tree", "global"])).toMatchObject({ command: "tree.next" });
    expect(d.feed("C-n", ["picker", "tree", "global"])).toMatchObject({ command: "picker.next" });
    expect(d.feed("C-a", ["editor", "global"])).toMatchObject({ binding: { context: "editor" } });
  });

  it("lists the continuations of a prefix", () => {
    const list = continuations(bindings, ["C-x"], ["editor", "global"]).map((c) => c.rest);
    expect(list).toEqual(["C-f", "C-s", "b"]);
  });
});
