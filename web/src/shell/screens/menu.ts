/**
 * Main menu.
 *
 * Four ways in, in the order a player actually needs them: a game against bots,
 * an online game, the world viewer that predates all of this, and the credits.
 * The online entry is present but disabled with a reason attached - hiding a
 * planned feature makes the roadmap invisible, and a greyed button with a
 * sentence next to it is more honest than a button that opens nothing.
 */

import { h } from "../dom.ts";
import type { Screen, Shell } from "../app.ts";

export function mainMenu(shell: Shell): Screen {
  const manifest = shell.manifest;

  const element = h(
    "div",
    { class: "screen menu" },
    h("div", { class: "menu__crest" }, "Warcraft III · перенос карты"),
    h("h1", {}, "War for ", h("em", {}, "WeldAran")),
    h("p", { class: "menu__author" }, manifest.author),

    h(
      "div",
      { class: "menu__actions" },
      h(
        "button",
        { class: "btn btn--primary", onclick: () => shell.lobby() },
        "Одиночная игра",
      ),
      h(
        "button",
        {
          class: "btn",
          disabled: true,
          title: "Этап B дорожной карты: lockstep на 12 игроков",
        },
        "Сетевая игра",
      ),
      h(
        "button",
        { class: "btn", onclick: () => shell.viewer() },
        "Просмотрщик мира",
      ),
    ),

    manifest.dataPresent
      ? h(
          "p",
          { class: "menu__note" },
          `Карта: ${manifest.tiles[0]} × ${manifest.tiles[1]} тайлов, `,
          `слотов ${manifest.players.length}, команд ${manifest.forces.length}.`,
        )
      : h(
          "p",
          { class: "menu__note" },
          "Данные карты не найдены — интерфейс работает, но мир пуст. ",
          "Соберите их одной командой: ",
          h("code", {}, "python3 build.py путь/к/WFWA.w3x"),
          ". До этого «Одиночная игра» запустит тренировочный бой на условных ",
          "характеристиках, а не саму карту.",
        ),

    h("div", { class: "menu__version" }, "оболочка 0.1 · движок 32 Гц"),
  );

  return { element };
}
