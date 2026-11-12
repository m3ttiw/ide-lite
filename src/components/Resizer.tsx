import type { JSX } from "solid-js";

interface Props {
  orient: "v" | "h";
  label: string;
  value: () => number;
  set: (n: number) => void;
  min: number;
  max: () => number;
  /** Dragging towards the start grows the panel (bottom panel). */
  invert?: boolean;
}

/** Drag handle (also keyboard-operable with the arrow keys). */
export function Resizer(props: Props): JSX.Element {
  let start = 0;
  let startVal = 0;
  let dragging = false;
  const clamp = (n: number) => Math.max(props.min, Math.min(props.max(), Math.round(n)));
  const pos = (e: PointerEvent) => (props.orient === "v" ? e.clientX : e.clientY);
  return (
    <div
      role="separator"
      tabindex="0"
      aria-orientation={props.orient === "v" ? "vertical" : "horizontal"}
      aria-label={props.label}
      aria-valuenow={props.value()}
      aria-valuemin={props.min}
      aria-valuemax={props.max()}
      class={`resizer resizer-${props.orient}`}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        start = pos(e);
        startVal = props.value();
        dragging = true;
        document.body.classList.add(`resizing-${props.orient}`);
      }}
      onPointerMove={(e) => {
        if (!dragging) return;
        const d = pos(e) - start;
        props.set(clamp(startVal + (props.invert ? -d : d)));
      }}
      onPointerUp={(e) => {
        dragging = false;
        e.currentTarget.releasePointerCapture(e.pointerId);
        document.body.classList.remove(`resizing-${props.orient}`);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 64 : 16;
        const grow = props.orient === "v" ? "ArrowRight" : props.invert ? "ArrowUp" : "ArrowDown";
        const shrink = props.orient === "v" ? "ArrowLeft" : props.invert ? "ArrowDown" : "ArrowUp";
        if (e.key === grow) props.set(clamp(props.value() + step));
        else if (e.key === shrink) props.set(clamp(props.value() - step));
        else return;
        e.preventDefault();
      }}
    />
  );
}
