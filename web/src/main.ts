/**
 * Entry point.
 *
 * Loads what the interface needs to describe the map, then hands control to the
 * shell. Deliberately thin: the map manifest is the only thing every screen needs
 * and the only thing worth fetching before one is shown.
 *
 * The world viewer that used to live in this file is now a screen of its own,
 * reachable from the menu.
 */

import "./shell/style.css";
import { Shell } from "./shell/app.ts";
import { loadMapManifest } from "./game/map-manifest.ts";

async function main(): Promise<void> {
  const root = document.getElementById("app");
  if (!root) throw new Error("Не найден контейнер #app.");

  const manifest = await loadMapManifest("/data");
  const shell = new Shell(root, manifest);
  shell.menu();

  // A failure inside a screen must not leave a blank page: the shell's own error
  // screen names the likely cause and the command that fixes it.
  window.addEventListener("error", (event) => {
    console.error(event.error ?? event.message);
  });
  window.addEventListener("unhandledrejection", (event) => {
    console.error(event.reason);
  });
}

main().catch((error) => {
  console.error(error);
  const root = document.getElementById("app");
  if (root) {
    root.textContent = error instanceof Error ? error.message : String(error);
  }
});
