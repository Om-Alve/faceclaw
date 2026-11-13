/**
 * Keys mode: an explicit secondary mode for interactive terminal apps. The
 * ring scrolls Up/Down, the watch's four swipes send arrows, and a tap sends
 * Enter; double tap leaves and restores normal scrolling. Read-only subagent
 * views never enter it.
 *
 * Outside Keys mode the watch's directions keep Faceclaw's normal meanings
 * (up/down scroll, right select, left back), so nothing here runs unless the
 * mode is on.
 */
export type KeysDirection = "up" | "down" | "left" | "right";

export const KEYS_MODE_TITLE = "KEYS";
export const KEYS_MODE_HINT = "tap Enter · double tap leaves";

/** The keys a directional input sends in Keys mode; empty for directions the mode leaves to the palette. */
export function keysForDirection(direction: KeysDirection): string[] {
  switch (direction) {
    case "up":
      return ["up"];
    case "down":
      return ["down"];
    case "left":
      return ["left"];
    case "right":
      return ["right"];
  }
}

/** The on-glasses banner: `KEYS → machine / pane`. */
export function keysModeBanner(machine: string, pane: string): string {
  return `${KEYS_MODE_TITLE} → ${machine} / ${pane}`;
}

/** Whether the mode may be offered for a view. */
export function canEnterKeysMode(readOnly: boolean, blocked: boolean): boolean {
  return !readOnly && !blocked;
}

/** Modes that end when the wearer leaves the window, sleeps, loses focus, or a new prompt appears. */
export type KeysModeExitReason = "back" | "focus_lost" | "sleep" | "blocked";

export function keysModeExits(reason: KeysModeExitReason): boolean {
  return reason === "back" || reason === "focus_lost" || reason === "sleep" || reason === "blocked";
}
