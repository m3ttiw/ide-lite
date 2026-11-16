import { For, Show, onMount, type JSX } from "solid-js";
import { resolveConfirm, type ConfirmSpec } from "../state/confirm";
import { Kbd, keyOf } from "./common";

/** Modal confirmation: C-RET confirms, ESC / C-g cancels. RET alone does nothing. */
export function ConfirmDialog(props: { spec: ConfirmSpec }): JSX.Element {
  let box!: HTMLDivElement;
  onMount(() => box.focus());
  const accept = () => keyOf("confirm.accept", ["confirm"]);
  const cancel = () => keyOf("app.cancel", ["confirm", "global"]);
  return (
    <div class="overlay confirm-veil" onMouseDown={(e) => e.target === e.currentTarget && resolveConfirm(false)}>
      <div
        ref={box}
        class="confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-body"
        tabindex="-1"
        data-ctx="confirm"
      >
        <h2 id="confirm-title" class="confirm-title">
          {props.spec.title}
        </h2>
        <div id="confirm-body" class="confirm-body">
          <Show when={props.spec.items?.length}>
            <ul class="confirm-list">
              <For each={props.spec.items}>
                {(it) => (
                  <li>
                    <span class="confirm-label">{it.label}</span>
                    <Show when={it.detail}>
                      <span class="confirm-detail">{it.detail}</span>
                    </Show>
                    <Show when={it.warn}>
                      <span class="confirm-warn">{it.warn}</span>
                    </Show>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={props.spec.note}>
            <p class="confirm-note">{props.spec.note}</p>
          </Show>
        </div>
        <div class="confirm-actions">
          <button type="button" class="st-btn" onClick={() => resolveConfirm(false)}>
            Annulla
            <Show when={cancel()}>
              {(k) => (
                <>
                  {" "}
                  <Kbd>{k()}</Kbd>
                </>
              )}
            </Show>
          </button>
          <button type="button" class="st-btn danger" onClick={() => resolveConfirm(true)}>
            {props.spec.confirmLabel}
            <Show when={accept()}>
              {(k) => (
                <>
                  {" "}
                  <Kbd>{k()}</Kbd>
                </>
              )}
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
}
