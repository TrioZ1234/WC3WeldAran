/**
 * Screen router.
 *
 * The shell owns exactly one screen at a time and the state that outlives a
 * screen: the map manifest, and the lobby the player last configured. A screen
 * is a DOM subtree plus an optional teardown - the match screen has a render
 * loop and a worker to stop, and losing track of either is how a browser tab
 * ends up simulating two games at once.
 */

import { clear } from "./dom.ts";
import type { MapManifest } from "../game/map-manifest.ts";
import { createMatchConfig, type MatchConfig } from "../game/match-config.ts";
import type { MatchOutcome } from "../game/protocol.ts";
import type { Snapshot } from "../game/protocol.ts";
import { mainMenu } from "./screens/menu.ts";
import { lobbyScreen } from "./screens/lobby.ts";
import { matchScreen } from "./screens/match.ts";
import { resultsScreen } from "./screens/results.ts";
import { fatalScreen } from "./screens/fatal.ts";
import { viewerScreen } from "./screens/viewer.ts";

export interface Screen {
  element: HTMLElement;
  dispose?: () => void;
}

/** Everything the results screen needs to report on a finished match. */
export interface MatchReport {
  config: MatchConfig;
  outcome: MatchOutcome;
  /** Last snapshot before the match ended, for the score columns. */
  final: Snapshot | null;
}

export class Shell {
  /** Kept between visits so a player who backs out of the lobby loses nothing. */
  private savedConfig: MatchConfig | null = null;
  private current: Screen | null = null;

  constructor(
    private root: HTMLElement,
    readonly manifest: MapManifest,
  ) {}

  private show(screen: Screen): void {
    this.current?.dispose?.();
    clear(this.root);
    this.root.appendChild(screen.element);
    this.current = screen;
  }

  menu(): void {
    this.show(mainMenu(this));
  }

  /** Open the lobby, reusing the previous configuration when there is one. */
  lobby(fresh = false): void {
    if (fresh || !this.savedConfig) this.savedConfig = createMatchConfig(this.manifest);
    this.show(lobbyScreen(this, this.savedConfig));
  }

  /** The original world viewer, kept as a diagnostic tool. */
  viewer(): void {
    this.show(viewerScreen(this));
  }

  startMatch(config: MatchConfig): void {
    this.savedConfig = config;
    this.show(matchScreen(this, config));
  }

  results(report: MatchReport): void {
    this.show(resultsScreen(this, report));
  }

  fatal(error: unknown): void {
    this.show(fatalScreen(this, error));
  }
}
