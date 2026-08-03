/**
 * Player identity: colours, races, difficulty levels.
 *
 * The twelve colours are Warcraft III's own slot palette in its own order.
 * Keeping the order means a screenshot of the lobby is readable to anyone who
 * played the map, and it means the minimap blips match what players expect.
 */

export const MAX_SLOTS = 12;

/** Index 12 is neutral hostile, 15 is neutral passive - same as the map's own use. */
export const NEUTRAL_HOSTILE = 12;
export const NEUTRAL_PASSIVE = 15;

export interface PlayerColour {
  index: number;
  name: string;
  /** CSS colour for the interface. */
  css: string;
  /** Linear-ish RGB in 0..1 for the renderer palette. */
  rgb: [number, number, number];
}

const hexToRgb = (hex: string): [number, number, number] => [
  parseInt(hex.slice(1, 3), 16) / 255,
  parseInt(hex.slice(3, 5), 16) / 255,
  parseInt(hex.slice(5, 7), 16) / 255,
];

const colour = (index: number, name: string, css: string): PlayerColour => ({
  index,
  name,
  css,
  rgb: hexToRgb(css),
});

export const PLAYER_COLOURS: PlayerColour[] = [
  colour(0, "красный", "#ff0303"),
  colour(1, "синий", "#0042ff"),
  colour(2, "бирюзовый", "#1ce6b9"),
  colour(3, "фиолетовый", "#540081"),
  colour(4, "жёлтый", "#fffc01"),
  colour(5, "оранжевый", "#fe8a0e"),
  colour(6, "зелёный", "#20c000"),
  colour(7, "розовый", "#e55bb0"),
  colour(8, "серый", "#959697"),
  colour(9, "голубой", "#7ebff1"),
  colour(10, "тёмно-зелёный", "#106246"),
  colour(11, "коричневый", "#4a2b05"),
];

export const NEUTRAL_COLOUR = colour(12, "нейтральный", "#8b0000");

export const colourOf = (slot: number): PlayerColour =>
  PLAYER_COLOURS[slot] ?? NEUTRAL_COLOUR;

// -- races ------------------------------------------------------------------

export type Race = "human" | "orc" | "undead" | "nightelf" | "random";

export const RACE_NAMES: Record<Race, string> = {
  human: "Люди",
  orc: "Орки",
  undead: "Нежить",
  nightelf: "Ночные эльфы",
  random: "Случайная",
};

export const RACES: Race[] = ["human", "orc", "undead", "nightelf", "random"];

/** Map data may carry races we do not offer; fall back rather than break the lobby. */
export function normaliseRace(value: string | undefined): Race {
  const candidate = String(value ?? "").toLowerCase();
  return (RACES as string[]).includes(candidate) ? (candidate as Race) : "human";
}

// -- difficulty -------------------------------------------------------------

/**
 * Bot difficulty. These are not cosmetic labels: the numbers feed the army
 * driver in the simulation, so they must stay integers - the whole point of
 * the fixed-point discipline is that a match replays identically everywhere.
 */
export type Difficulty = "easy" | "normal" | "hard" | "insane";

export interface DifficultyProfile {
  id: Difficulty;
  name: string;
  /** Percent applied to the bot's damage and hit points, 100 = no change. */
  handicap: number;
  /** Seconds a bot waits after a wave spawns before committing it to an attack. */
  regroupSeconds: number;
  /** Minimum units a bot gathers before it marches. */
  waveSize: number;
}

export const DIFFICULTIES: Record<Difficulty, DifficultyProfile> = {
  easy: { id: "easy", name: "Слабый", handicap: 80, regroupSeconds: 45, waveSize: 10 },
  normal: { id: "normal", name: "Обычный", handicap: 100, regroupSeconds: 25, waveSize: 7 },
  hard: { id: "hard", name: "Сильный", handicap: 115, regroupSeconds: 12, waveSize: 5 },
  insane: { id: "insane", name: "Безумный", handicap: 135, regroupSeconds: 5, waveSize: 3 },
};

export const DIFFICULTY_ORDER: Difficulty[] = ["easy", "normal", "hard", "insane"];

/** Names for computer players, so a lobby of bots is not twelve "Компьютер". */
export const BOT_NAMES = [
  "Аран", "Веллед", "Гортан", "Дарнис", "Ерсул", "Живодар",
  "Заран", "Илмат", "Корвус", "Луфар", "Морн", "Нордир",
];
