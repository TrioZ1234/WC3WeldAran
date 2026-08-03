/**
 * The lobby: twelve slots, and everything a host decides before a match.
 *
 * The map defines the slots - twelve players in six forces - so this screen
 * edits them rather than inventing them. A slot the map never declared cannot be
 * opened here, which is why closed rows are shown greyed instead of hidden: the
 * shape of the map should be visible, including the parts the player may not
 * change.
 *
 * The screen re-renders wholesale on every edit. With twelve rows that costs
 * nothing measurable, and it removes the entire class of bugs where the
 * interface and the configuration disagree about what the player chose.
 */

import { h, clear } from "../dom.ts";
import type { Screen, Shell } from "../app.ts";
import {
  DIFFICULTIES,
  DIFFICULTY_ORDER,
  RACES,
  RACE_NAMES,
  colourOf,
  type Difficulty,
  type Race,
} from "../../game/players.ts";
import {
  balanceTeams,
  clearBots,
  describeMatch,
  fillWithBots,
  playingSlots,
  setKind,
  teamSizes,
  validate,
  type MatchConfig,
  type MatchSlot,
  type SlotKind,
} from "../../game/match-config.ts";

const KIND_NAMES: Record<SlotKind, string> = {
  human: "Человек",
  computer: "Компьютер",
  open: "Открыт",
  closed: "Закрыт",
};

const HANDICAPS = [50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150];

export function lobbyScreen(shell: Shell, config: MatchConfig): Screen {
  const manifest = shell.manifest;
  const teamCount = Math.max(2, manifest.forces.length || 2);
  const chatLog: Array<{ who: string; text: string; colour?: string }> = [
    {
      who: "Система",
      text: manifest.dataPresent
        ? "Лобби открыто. Свободные слоты можно занять компьютерными игроками."
        : "Данные карты не собраны — будет запущен тренировочный бой.",
    },
  ];

  const slotsHost = h("div", { class: "lobby__slots" });
  const sideHost = h("div", { class: "lobby__side" });
  const statusHost = h("div", { class: "lobby__status" });
  const startButton = h("button", { class: "btn btn--primary" }, "Начать игру");

  const element = h(
    "div",
    { class: "screen lobby" },
    h(
      "div",
      { class: "lobby__head" },
      h("h2", {}, "Лобби"),
      h("span", { class: "dim" }, manifest.name),
      h("span", { class: "faint mono" }, `${manifest.tiles[0]}×${manifest.tiles[1]}`),
    ),
    h("div", { class: "lobby__body" }, slotsHost, sideHost),
    h(
      "div",
      { class: "lobby__foot" },
      h("button", { class: "btn", onclick: () => shell.menu() }, "Назад"),
      statusHost,
      startButton,
    ),
  );

  function say(who: string, text: string, colour?: string): void {
    chatLog.push({ who, text, colour });
    if (chatLog.length > 60) chatLog.shift();
  }

  // -- slot rows ------------------------------------------------------------

  function slotRow(slot: MatchSlot): HTMLElement {
    const colour = colourOf(slot.slot);
    const playable = slot.kind === "human" || slot.kind === "computer";

    const nameCell = slot.local
      ? h("div", { class: "slot__name" },
          h("input", {
            type: "text",
            value: slot.name,
            maxlength: 18,
            oninput: (event: Event) => {
              slot.name = (event.target as HTMLInputElement).value.slice(0, 18) || "Игрок";
            },
          }),
          h("span", { class: "slot__tag" }, "вы"),
        )
      : h("div", { class: "slot__label" }, slot.name);

    const control = h(
      "select",
      {
        disabled: slot.fixedByMap || slot.local,
        onchange: (event: Event) => {
          const kind = (event.target as HTMLSelectElement).value as SlotKind;
          setKind(config, slot.slot, kind);
          say("Система", `Слот ${slot.slot + 1}: ${KIND_NAMES[kind].toLowerCase()}`, colour.css);
          render();
        },
      },
      ...(slot.local
        ? [option("human", KIND_NAMES.human, true)]
        : slot.fixedByMap
          ? [option("closed", "нет в карте", true)]
          : (["open", "computer", "closed"] as SlotKind[]).map((kind) =>
              option(kind, KIND_NAMES[kind], kind === slot.kind),
            )),
    );

    const race = h(
      "select",
      {
        disabled: !playable,
        onchange: (event: Event) => {
          slot.race = (event.target as HTMLSelectElement).value as Race;
        },
      },
      ...RACES.map((id) => option(id, RACE_NAMES[id], id === slot.race)),
    );

    const team = h(
      "select",
      {
        disabled: !playable,
        onchange: (event: Event) => {
          slot.team = Number((event.target as HTMLSelectElement).value);
          render();
        },
      },
      ...Array.from({ length: teamCount }, (_, index) =>
        option(String(index + 1), `Команда ${index + 1}`, slot.team === index + 1),
      ),
    );

    // One column serves two purposes: bots get a difficulty, humans a handicap.
    // They are the same decision - how hard this seat should be - so they share
    // the space rather than each claiming a column that is empty half the time.
    const tuning =
      slot.kind === "computer"
        ? h(
            "select",
            {
              onchange: (event: Event) => {
                slot.difficulty = (event.target as HTMLSelectElement).value as Difficulty;
              },
            },
            ...DIFFICULTY_ORDER.map((id) =>
              option(id, DIFFICULTIES[id].name, id === slot.difficulty),
            ),
          )
        : h(
            "select",
            {
              disabled: !playable,
              onchange: (event: Event) => {
                slot.handicap = Number((event.target as HTMLSelectElement).value);
                render();
              },
            },
            ...HANDICAPS.map((percent) =>
              option(String(percent), `${percent}%`, slot.handicap === percent),
            ),
          );

    return h(
      "div",
      {
        class: [
          "slot",
          slot.local ? "slot--local" : "",
          playable ? "" : "slot--closed",
        ].join(" ").trim(),
      },
      h("div", { class: "slot__colour", style: `background:${colour.css}` }),
      h("div", { class: "slot__index" }, slot.slot + 1),
      nameCell,
      control,
      race,
      team,
      tuning,
      h(
        "div",
        { class: `slot__ready slot__ready--${slot.ready ? "yes" : "no"}` },
        slot.ready ? "✓" : "·",
      ),
    );
  }

  function renderSlots(): void {
    clear(slotsHost);
    slotsHost.appendChild(
      h(
        "div",
        { class: "slots__head" },
        h("span", {}),
        h("span", {}, "#"),
        h("span", {}, "Игрок"),
        h("span", {}, "Управление"),
        h("span", {}, "Раса"),
        h("span", {}, "Команда"),
        h("span", {}, "Сложность"),
        h("span", {}, "Гот."),
      ),
    );
    for (const slot of config.slots) slotsHost.appendChild(slotRow(slot));

    const fillDifficulty = h(
      "select",
      { style: "width:130px" },
      ...DIFFICULTY_ORDER.map((id) => option(id, DIFFICULTIES[id].name, id === "normal")),
    );

    slotsHost.appendChild(
      h(
        "div",
        { class: "slots__tools" },
        h(
          "button",
          {
            class: "btn btn--small",
            onclick: () => {
              const difficulty = fillDifficulty.value as Difficulty;
              const filled = fillWithBots(config, difficulty);
              say(
                "Система",
                filled > 0
                  ? `Свободные слоты заняты компьютерами (${filled}), сложность «${DIFFICULTIES[difficulty].name.toLowerCase()}»`
                  : "Свободных слотов нет",
              );
              render();
            },
          },
          "Заполнить ботами",
        ),
        fillDifficulty,
        h(
          "button",
          {
            class: "btn btn--small",
            onclick: () => {
              const removed = clearBots(config);
              say("Система", removed > 0 ? `Убрано компьютеров: ${removed}` : "Компьютеров нет");
              render();
            },
          },
          "Убрать ботов",
        ),
        h(
          "button",
          {
            class: "btn btn--small",
            onclick: () => {
              balanceTeams(config, teamCount);
              say("Система", "Игроки разбиты по командам поровну");
              render();
            },
          },
          "Разбить по командам",
        ),
        h(
          "button",
          {
            class: "btn btn--small",
            onclick: () => {
              // Deliberately uses Math.random: this is a lobby choice made once,
              // before the deterministic part of the match begins. The seed the
              // simulation runs on is the only randomness that must be reproducible.
              for (const slot of playingSlots(config)) {
                slot.race = RACES[Math.floor(Math.random() * (RACES.length - 1))];
              }
              say("Система", "Расы выбраны случайно");
              render();
            },
          },
          "Случайные расы",
        ),
      ),
    );
  }

  // -- side panels ----------------------------------------------------------

  function renderSide(): void {
    clear(sideHost);
    const report = validate(config);
    const sizes = [...teamSizes(config).entries()].sort((a, b) => a[0] - b[0]);

    sideHost.appendChild(
      h(
        "div",
        { class: "panel card" },
        h("h3", {}, "Карта"),
        h("div", { class: "field" }, h("span", {}, "Название"), h("span", { class: "dim" }, manifest.name)),
        h("div", { class: "field" }, h("span", {}, "Автор"), h("span", { class: "dim" }, manifest.author)),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Размер"),
          h("span", { class: "dim mono" }, `${manifest.tiles[0]}×${manifest.tiles[1]}`),
        ),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Слотов"),
          h("span", { class: "dim mono" }, `${manifest.players.length} / команд ${manifest.forces.length}`),
        ),
        !manifest.dataPresent &&
          h("div", { class: "notice notice--error", style: "margin-top:10px" }, manifest.description),
      ),
    );

    sideHost.appendChild(
      h(
        "div",
        { class: "panel card" },
        h("h3", {}, "Правила"),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Скорость"),
          h(
            "select",
            {
              onchange: (event: Event) => {
                config.speed = Number((event.target as HTMLSelectElement).value) as 1 | 2 | 4;
              },
            },
            ...[1, 2, 4].map((rate) =>
              option(String(rate), rate === 1 ? "обычная" : `×${rate}`, config.speed === rate),
            ),
          ),
        ),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Волна из города"),
          h(
            "select",
            {
              onchange: (event: Event) => {
                config.spawnPeriod = Number((event.target as HTMLSelectElement).value);
              },
            },
            ...[45, 60, 90, 120].map((period) =>
              option(String(period), `${period} с`, config.spawnPeriod === period),
            ),
          ),
        ),
        h("div", { class: "field__hint" }, "В карте это 90 секунд — udg_SpawnTimer."),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Общий обзор союзников"),
          h("input", {
            type: "checkbox",
            class: "switch",
            checked: config.sharedVision,
            onchange: (event: Event) => {
              config.sharedVision = (event.target as HTMLInputElement).checked;
            },
          }),
        ),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Открыть карту"),
          h("input", {
            type: "checkbox",
            class: "switch",
            checked: config.revealMap,
            onchange: (event: Event) => {
              config.revealMap = (event.target as HTMLInputElement).checked;
            },
          }),
        ),
        h(
          "div",
          { class: "field" },
          h("span", {}, "Зерно"),
          h("span", { class: "dim mono" }, String(config.seed)),
        ),
        h(
          "div",
          { class: "field__hint" },
          "Одно зерно — один и тот же бой. Это условие сетевой игры, а не отладочная мелочь.",
        ),
      ),
    );

    sideHost.appendChild(
      h(
        "div",
        { class: "panel card" },
        h("h3", {}, "Расстановка"),
        h(
          "div",
          { class: "teams" },
          ...sizes.map(([team, size]) =>
            h(
              "div",
              { class: "teams__row" },
              h("span", { style: "width:86px" }, `Команда ${team}`),
              h(
                "div",
                { class: "teams__dots" },
                ...playingSlots(config)
                  .filter((slot) => slot.team === team)
                  .map((slot) =>
                    h("span", {
                      class: "teams__dot",
                      title: slot.name,
                      style: `background:${colourOf(slot.slot).css}`,
                    }),
                  ),
              ),
              h("span", { class: "faint mono" }, String(size)),
            ),
          ),
          sizes.length === 0 && h("span", { class: "faint" }, "Игроков нет"),
        ),
        h("hr", { class: "rule" }),
        ...report.errors.map((text) => h("div", { class: "notice notice--error" }, text)),
        ...report.warnings.map((text) => h("div", { class: "notice" }, text)),
      ),
    );

    sideHost.appendChild(renderChat());
  }

  function renderChat(): HTMLElement {
    const log = h(
      "div",
      { class: "chat__log" },
      ...chatLog.map((line) =>
        h(
          "div",
          { class: "chat__line" },
          h("b", { style: line.colour ? `color:${line.colour}` : "color:var(--gold)" }, `${line.who}: `),
          h("span", { class: "dim" }, line.text),
        ),
      ),
    );

    const input = h("input", {
      type: "text",
      placeholder: "Сообщение…",
      maxlength: 120,
      onkeydown: (event: KeyboardEvent) => {
        if (event.key !== "Enter") return;
        const text = (event.target as HTMLInputElement).value.trim();
        if (!text) return;
        const me = config.slots.find((slot) => slot.local);
        say(me?.name ?? "Игрок", text, me ? colourOf(me.slot).css : undefined);
        render();
      },
    });

    const panel = h(
      "div",
      { class: "panel card chat" },
      h("h3", {}, "Чат лобби"),
      log,
      h("div", { class: "chat__entry" }, input),
    );
    // Newest line at the bottom, as any chat does.
    queueMicrotask(() => {
      log.scrollTop = log.scrollHeight;
    });
    return panel;
  }

  // -- footer ---------------------------------------------------------------

  function renderStatus(): void {
    const report = validate(config);
    clear(statusHost);
    statusHost.appendChild(
      h(
        "span",
        {},
        report.ok
          ? `${describeMatch(config)} · всё готово`
          : report.errors[0] ?? "Настройте слоты",
      ),
    );
    startButton.disabled = !report.ok;
    startButton.title = report.ok ? "" : report.errors.join(" ");
  }

  startButton.addEventListener("click", () => {
    if (!validate(config).ok) return;
    shell.startMatch(config);
  });

  function render(): void {
    renderSlots();
    renderSide();
    renderStatus();
  }

  render();
  return { element };
}

function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  return h("option", { value, selected: selected || undefined }, label);
}
