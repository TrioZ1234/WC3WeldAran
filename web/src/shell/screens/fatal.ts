/**
 * The failure screen.
 *
 * It exists so that no failure ends as a black rectangle. Two things a player can
 * act on: what broke, and the fact that most of what breaks here is a missing
 * build rather than a bug - so the command that produces the data is on screen
 * next to the error, not buried in a README.
 */

import { h } from "../dom.ts";
import type { Screen, Shell } from "../app.ts";

export function fatalScreen(shell: Shell, error: unknown): Screen {
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error && error.stack ? error.stack : "";

  const element = h(
    "div",
    { class: "screen fatal" },
    h("h2", {}, "Не удалось запустить"),
    h("p", { class: "dim" }, message),
    h(
      "p",
      { class: "faint" },
      "Чаще всего причина в том, что данные карты не собраны. Соберите их из корня репозитория:",
    ),
    h("pre", {}, "python3 build.py путь/к/WFWA_v0.9.9q.w3x"),
    stack && h("pre", { class: "faint" }, stack.split("\n").slice(0, 8).join("\n")),
    h(
      "div",
      { style: "display:flex;gap:10px" },
      h("button", { class: "btn", onclick: () => shell.menu() }, "В главное меню"),
      h("button", { class: "btn btn--quiet", onclick: () => location.reload() }, "Перезагрузить"),
    ),
  );

  return { element };
}
