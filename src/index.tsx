/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./core/commands";
import { installKeyboard } from "./core/keyboard";
import "./styles.css";

installKeyboard();
render(() => <App />, document.getElementById("root") as HTMLElement);
