/**
 * The in-game interface: resources, clock, selection, orders, scoreboard, log.
 *
 * Built once, then updated in place from each snapshot. Rebuilding this subtree
 * sixteen times a second would be visible - text selection would drop, hover
 * would flicker - so the only thing that changes here per frame is the contents
 * of nodes that already exist.
 *
 * Two rules the layout follows, both taken from what the map itself is about.
 * Cities spawn armies on a 90-second timer, so the countdown to the next wave sits
 * beside the clock rather than buried. And with twelve players, the scoreboard is
 * not a curiosity but the way a player knows which of six teams is actually
 * winning, so it is always on screen.
 */

import { formatClock, formatNumber, h } from "../shell/dom.ts";
import {
  MAX_SLOTS,
  colourOf,
  type Difficulty,
  DIFFICULTIES,
} from "../game/players.ts";
import {
  PLAYER_STRIDE,
  UNIT_FLAG_BUILDING,
  UNIT_STRIDE,
  type Snapshot,
} from "../game/protocol.ts";
import { playingSlots, type MatchConfig, type MatchSlot } from "../game/match-config.ts";

export type CommandId = "move" | "attack" | "stop" | "hold" | "centre" | "menu";

export interface HudCallbacks {
  onCommand: (command: CommandId) => void;
  /** A portrait in the selection grid was clicked: focus that unit. */
  onFocusUnit: (id: number) => void;
}

interface CommandSpec {
  id: CommandId;
  label: string;
  key: string;
  /** Set when the button is present to show the plan, not to be pressed yet. */
  pending?: string;
}

const COMMANDS: CommandSpec[] = [
  { id: "move", label: "Движение", key: "M" },
  { id: "attack", label: "Атака", key: "A" },
  { id: "stop", label: "Стоп", key: "S" },
  { id: "hold", label: "Удержание", key: "H" },
  { id: "centre", label: "К войскам", key: "Space" },
  { id: "menu", label: "Меню", key: "F10" },
];

/** Buttons the original map's command card has and this engine does not yet. */
const PENDING: CommandSpec[] = [
  { id: "move", label: "Патруль", key: "P", pending: "Поиск пути ещё не реализован" },
  { id: "move", label: "Способности", key: "", pending: "Способности карты ещё не перенесены" },
];

export class Hud {
  readonly element: HTMLElement;
  readonly minimapCanvas: HTMLCanvasElement;
  readonly marquee: HTMLElement;

  private gold = h("b", {}, "0");
  private lumber = h("b", {}, "0");
  private army = h("b", {}, "0");
  private clock = h("div", { class: "hud__clock" }, "00:00");
  private spawn = h("div", { class: "hud__spawn" }, "волна через —");
  private selectionHost = h("div", { class: "selection" });
  private scoreHost = h("div", { class: "panel score" });
  private logHost = h("div", { class: "log" });
  private diagnostics = h("div", { class: "hud__diag" });
  private flag: HTMLElement | null = null;
  private commandButtons = new Map<CommandId, HTMLButtonElement>();
  private lines: Array<{ text: string; slot?: number }> = [];
  private typeNames: string[] = [];

  constructor(
    private config: MatchConfig,
    private callbacks: HudCallbacks,
  ) {
    this.minimapCanvas = h("canvas", { title: "Щёлкните, чтобы перевести камеру" });
    this.marquee = h("div", { class: "marquee" });

    this.element = h(
      "div",
      { class: "hud" },
      this.marquee,
      h(
        "div",
        { class: "hud__top" },
        h("div", { class: "res res--gold" }, h("span", { class: "res__mark" }), this.gold),
        h("div", { class: "res res--lumber" }, h("span", { class: "res__mark" }), this.lumber),
        h("div", { class: "res res--army" }, h("span", { class: "res__mark" }), this.army),
        this.clock,
        this.spawn,
      ),
      this.logHost,
      this.scoreHost,
      this.diagnostics,
      h(
        "div",
        { class: "hud__bottom" },
        h("div", {}, h("div", { class: "minimap" }, this.minimapCanvas)),
        this.selectionHost,
        h("div", {}, this.buildCommands()),
      ),
    );

    this.renderScore(null);
    this.renderSelection(null, []);
  }

  /** A standing label for a training match, so it is never mistaken for the map. */
  setFlag(text: string | null): void {
    this.flag?.remove();
    this.flag = null;
    if (!text) return;
    this.flag = h("div", { class: "hud__flag" }, text);
    this.element.appendChild(this.flag);
  }

  private buildCommands(): HTMLElement {
    const grid = h("div", { class: "commands" });
    for (const spec of COMMANDS) {
      const button = h(
        "button",
        {
          class: "command",
          onclick: () => this.callbacks.onCommand(spec.id),
        },
        spec.label,
        spec.key && h("kbd", {}, spec.key),
      );
      this.commandButtons.set(spec.id, button);
      grid.appendChild(button);
    }
    for (const spec of PENDING) {
      grid.appendChild(
        h(
          "button",
          { class: "command", disabled: true, title: spec.pending },
          spec.label,
          spec.key && h("kbd", {}, spec.key),
        ),
      );
    }
    return grid;
  }

  /** Highlight the order the player has armed but not yet placed. */
  setArmedCommand(command: CommandId | null): void {
    for (const [id, button] of this.commandButtons) {
      button.classList.toggle("command--active", id === command);
    }
  }

  // -- per-snapshot ---------------------------------------------------------

  update(snapshot: Snapshot, selected: number[], fps: number): void {
    const local = this.config.slots.find((slot) => slot.local)?.slot ?? 0;
    const at = local * PLAYER_STRIDE;

    this.gold.textContent = formatNumber(snapshot.players[at + 0]);
    this.lumber.textContent = formatNumber(snapshot.players[at + 1]);
    this.army.textContent = formatNumber(snapshot.players[at + 2]);
    this.clock.textContent = formatClock(snapshot.seconds);
    this.spawn.innerHTML = "";
    this.spawn.append(
      document.createTextNode("волна через "),
      h("b", {}, snapshot.nextSpawn > 0 ? formatClock(snapshot.nextSpawn) : "—"),
    );

    this.renderScore(snapshot);
    this.renderSelection(snapshot, selected);

    this.diagnostics.textContent =
      `юнитов ${formatNumber(snapshot.unitCount)} / ${formatNumber(snapshot.totalUnits)} · ` +
      `тик ${formatNumber(snapshot.tick)} · симуляция ${snapshot.simMs.toFixed(1)} мс · ` +
      `${fps.toFixed(0)} FPS`;
  }

  /**
   * The scoreboard.
   *
   * Grouped by team, because with six teams the per-player list alone does not
   * answer the question a player actually has. Eliminated players stay listed and
   * struck through: knowing who is already out is part of reading the board.
   */
  private renderScore(snapshot: Snapshot | null): void {
    const local = this.config.slots.find((slot) => slot.local)?.slot ?? 0;
    const byTeam = new Map<number, MatchSlot[]>();
    for (const slot of playingSlots(this.config)) {
      const list = byTeam.get(slot.team) ?? [];
      list.push(slot);
      byTeam.set(slot.team, list);
    }

    const rows: HTMLElement[] = [];
    for (const [team, slots] of [...byTeam.entries()].sort((a, b) => a[0] - b[0])) {
      let teamUnits = 0;
      for (const slot of slots) {
        if (snapshot) teamUnits += snapshot.players[slot.slot * PLAYER_STRIDE + 2];
      }
      rows.push(
        h("div", { class: "score__team" }, `Команда ${team} · войск ${formatNumber(teamUnits)}`),
      );
      for (const slot of slots) {
        const stats = snapshot
          ? {
              units: snapshot.players[slot.slot * PLAYER_STRIDE + 2],
              losses: snapshot.players[slot.slot * PLAYER_STRIDE + 4],
              alive: snapshot.players[slot.slot * PLAYER_STRIDE + 5] > 0,
            }
          : { units: 0, losses: 0, alive: true };

        rows.push(
          h(
            "div",
            {
              class: [
                "score__row",
                stats.alive ? "" : "score__row--dead",
                slot.slot === local ? "score__row--local" : "",
              ].join(" ").trim(),
              title:
                slot.kind === "computer"
                  ? `Компьютер · ${DIFFICULTIES[slot.difficulty as Difficulty].name}`
                  : "Человек",
            },
            h("span", { class: "score__swatch", style: `background:${colourOf(slot.slot).css}` }),
            h("span", { class: "score__name" }, slot.name),
            h("span", { class: "mono" }, formatNumber(stats.units)),
            h("span", { class: "mono faint" }, formatNumber(stats.losses)),
          ),
        );
      }
    }

    this.scoreHost.innerHTML = "";
    this.scoreHost.append(h("h3", {}, "Игроки"), ...rows);
  }

  /**
   * The selection panel.
   *
   * Shows the lead unit's numbers and a portrait for each of the rest. Hit points
   * are on the portraits rather than in a list, because a player scanning a
   * damaged group needs to see which one is nearly dead, not read twelve numbers.
   */
  private renderSelection(snapshot: Snapshot | null, selected: number[]): void {
    this.selectionHost.innerHTML = "";
    if (!snapshot || selected.length === 0) {
      this.selectionHost.appendChild(
        h(
          "div",
          { class: "selection__empty" },
          "Ничего не выделено. Обведите войска рамкой, правая кнопка — приказ.",
        ),
      );
      return;
    }

    const chosen = new Set(selected);
    const found: Array<{ id: number; type: number; hp: number; building: boolean }> = [];
    for (let index = 0; index < snapshot.unitCount; index++) {
      const at = index * UNIT_STRIDE;
      const id = snapshot.units[at + 0];
      if (!chosen.has(id)) continue;
      found.push({
        id,
        type: snapshot.units[at + 4],
        hp: snapshot.units[at + 5],
        building: (snapshot.units[at + 7] & UNIT_FLAG_BUILDING) !== 0,
      });
    }

    if (found.length === 0) {
      this.selectionHost.appendChild(
        h("div", { class: "selection__empty" }, "Выделенные войска погибли."),
      );
      return;
    }

    const lead = found[0];
    const totalHp = found.reduce((sum, unit) => sum + unit.hp, 0) / found.length;

    this.selectionHost.append(
      h(
        "div",
        { class: "selection__lead" },
        h("b", {}, this.typeName(lead.type)),
        found.length > 1 && h("span", { class: "dim" }, `× ${found.length}`),
        lead.building && h("span", { class: "slot__tag" }, "строение"),
      ),
      h(
        "div",
        { class: "selection__stats" },
        h("span", {}, "здоровье ", h("b", {}, `${Math.round(totalHp * 100)}%`)),
        h("span", {}, "выделено ", h("b", {}, String(found.length))),
      ),
      h(
        "div",
        { class: "selection__grid" },
        ...found.slice(0, 48).map((unit) =>
          h(
            "div",
            {
              class: "portrait",
              title: `${this.typeName(unit.type)} · ${Math.round(unit.hp * 100)}%`,
              onclick: () => this.callbacks.onFocusUnit(unit.id),
            },
            h("div", {
              class: [
                "portrait__hp",
                unit.hp < 0.34 ? "portrait__hp--dying" : unit.hp < 0.7 ? "portrait__hp--hurt" : "",
              ].join(" ").trim(),
              style: `width:${Math.max(4, unit.hp * 100)}%`,
            }),
          ),
        ),
      ),
    );
  }

  setTypeNames(names: string[]): void {
    this.typeNames = names;
  }

  private typeName(index: number): string {
    return this.typeNames[index] ?? "Юнит";
  }

  // -- log ------------------------------------------------------------------

  /** Append a line to the message log, newest at the bottom. */
  log(text: string, slot?: number): void {
    this.lines.push({ text, slot });
    if (this.lines.length > 8) this.lines.shift();

    this.logHost.innerHTML = "";
    // The container is column-reverse, so prepending in order leaves the newest
    // line at the bottom while older ones drift up and out.
    for (const line of this.lines) {
      const colour =
        line.slot !== undefined && line.slot < MAX_SLOTS ? colourOf(line.slot).css : undefined;
      this.logHost.prepend(
        h(
          "div",
          { class: "log__line" },
          h("b", { style: colour ? `color:${colour}` : "" }, "\u00bb "),
          line.text,
        ),
      );
    }
  }
}
