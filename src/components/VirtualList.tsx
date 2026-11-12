import { For, createEffect, createMemo, createSignal, onCleanup, onMount, untrack, type JSX } from "solid-js";

export interface VirtualListApi {
  scrollToIndex(i: number, align?: "auto" | "start" | "center"): void;
  scrollBy(px: number): void;
  /** Rows that fit in the viewport. */
  pageRows(): number;
  /** First row whose top is visible. */
  firstVisible(): number;
  element(): HTMLDivElement;
}

interface Props {
  count: number;
  rowHeight: number;
  overscan?: number;
  class?: string;
  style?: JSX.CSSProperties;
  row: (i: number) => JSX.Element;
  /** Extra content drawn in the scrolled area for the rendered range (e.g. the commit graph). */
  overlay?: (start: number, end: number) => JSX.Element;
  onRange?: (start: number, end: number) => void;
  ref?: (api: VirtualListApi) => void;
}

/** Renders only the rows on screen (plus a few) of a fixed-row-height list. */
export function VirtualList(props: Props): JSX.Element {
  let el!: HTMLDivElement;
  const [top, setTop] = createSignal(0);
  const [height, setHeight] = createSignal(0);

  const range = createMemo(
    () => {
      const rh = props.rowHeight;
      const os = props.overscan ?? 6;
      const start = Math.max(0, Math.floor(top() / rh) - os);
      const end = Math.min(props.count, Math.ceil((top() + height()) / rh) + os);
      return [start, Math.max(start, end)] as [number, number];
    },
    [0, 0] as [number, number],
    { equals: (a, b) => a[0] === b[0] && a[1] === b[1] },
  );

  const indices = createMemo(() => {
    const [s, e] = range();
    const out: number[] = [];
    for (let i = s; i < e; i++) out.push(i);
    return out;
  });

  createEffect(() => {
    const [s, e] = range();
    untrack(() => props.onRange?.(s, e));
  });

  onMount(() => {
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    onCleanup(() => ro.disconnect());
  });

  const api: VirtualListApi = {
    scrollToIndex(i, align = "auto") {
      const rh = props.rowHeight;
      const h = el.clientHeight;
      const y = i * rh;
      if (align === "start") el.scrollTop = y;
      else if (align === "center") el.scrollTop = y - h / 2 + rh / 2;
      else if (y < el.scrollTop) el.scrollTop = y;
      else if (y + rh > el.scrollTop + h) el.scrollTop = y + rh - h;
      setTop(el.scrollTop);
    },
    scrollBy(px) {
      el.scrollTop += px;
      setTop(el.scrollTop);
    },
    pageRows: () => Math.max(1, Math.floor(el.clientHeight / props.rowHeight) - 1),
    firstVisible: () => Math.floor(el.scrollTop / props.rowHeight),
    element: () => el,
  };
  props.ref?.(api);

  return (
    <div ref={el} class={`vlist ${props.class ?? ""}`} style={props.style} onScroll={() => setTop(el.scrollTop)}>
      <div class="vlist-inner" style={{ height: `${props.count * props.rowHeight}px` }}>
        {props.overlay?.(range()[0], range()[1])}
        <For each={indices()}>
          {(i) => (
            <div class="vrow" style={{ transform: `translateY(${i * props.rowHeight}px)`, height: `${props.rowHeight}px` }}>
              {props.row(i)}
            </div>
          )}
        </For>
      </div>
    </div>
  );
}
