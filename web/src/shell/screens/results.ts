/**
 * End of match.
 *
 * The scoreboard is the last snapshot, not a separate tally, so the numbers here
 * are the same ones that were on screen a second ago. A results screen that
 * disagrees with the HUD it replaced teaches players to trust neither.
 */

import { formatClock, formatNumber, h } from "../dom.ts";
import type { MatchReport, Screen, Shell } from "../app.ts";
import { DIFFICULTIES, colourOf } from "../../game/players.ts";
import { playingSlots } from "../../game/match-config.ts";
import { PLAYER_STRIDE } from "../../game/protocol.ts";

export function resultsScreen(shell: Shell, report: MatchReport): Screen {
  const { config, outcome, final } = report;
  const local = config.slots.find((slot) => slot.local)?.slot ?? 0;

  const rows = playingSlots(config)
    .map((slot) => {
      const at = slot.slot * PLAYER_STRIDE;
      return {
        slot,
        units: final ? final.players[at + 2] : 0,
        kills: final ? final.players[at + 3] : 0,
        losses: final ? final.players[at + 4] : 0,
        survived: outcome.survivors.includes(slot.slot),
      };
    })
    .sort((a, b) => Number(b.survived) - Number(a.survived) || b.units - a.units);

  const element = h(
    "div",
    { class: `screen results ${outcome.victory ? "results--won" : "results--lost"}` },
    h("h1", {}, outcome.victory ? "Победа" : "Поражение"),
    h("p", { class: "dim" }, outcome.reason),
    h(
      "p",
      { class: "faint mono" },
      `${config.mapName} · ${formatClock(outcome.seconds)} игрового времени`,
    ),

    h(
      "table",
      { class: "results__table" },
      h(
        "thead",
        {},
        h(
          "tr",
          {},
          h("th", {}, "Игрок"),
          h("th", {}, "Управление"),
          h("th", {}, "Команда"),
          h("th", {}, "Войск"),
          h("th", {}, "Убито"),
          h("th", {}, "Потерь"),
        ),
      ),
      h(
        "tbody",
        {},
        ...rows.map((row) =>
          h(
            "tr",
            { style: row.survived ? "" : "opacity:.5" },
            h(
              "td",
              {},
              h("span", {
                class: "score__swatch",
                style: `background:${colourOf(row.slot.slot).css};display:inline-block;margin-right:8px`,
              }),
              row.slot.name,
              row.slot.slot === local && h("span", { class: "slot__tag", style: "margin-left:8px" }, "вы"),
            ),
            h(
              "td",
              { class: "dim" },
              row.slot.kind === "computer"
                ? DIFFICULTIES[row.slot.difficulty].name
                : "Человек",
            ),
            h("td", { class: "dim" }, String(row.slot.team)),
            h("td", { class: "mono" }, formatNumber(row.units)),
            h("td", { class: "mono" }, formatNumber(row.kills)),
            h("td", { class: "mono faint" }, formatNumber(row.losses)),
          ),
        ),
      ),
    ),

    h(
      "div",
      { class: "results__actions" },
      h(
        "button",
        {
          class: "btn btn--primary",
          onclick: () => {
            // A rematch is the same lobby with a new seed: same sides, different fight.
            config.seed = (Date.now() ^ 0x5eed) >>> 0;
            shell.startMatch(config);
          },
        },
        "Ещё раз",
      ),
      h("button", { class: "btn", onclick: () => shell.lobby() }, "В лобби"),
      h("button", { class: "btn btn--quiet", onclick: () => shell.menu() }, "Главное меню"),
    ),
  );

  return { element };
}
