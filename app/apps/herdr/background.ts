import { isHerdrWidgetInUse } from "../glanceboard/configuration";
import { loadMachines } from "./machines";
import { wakeOnBlockedEnabled } from "./settings";

/**
 * Whether the Herdr worker must stay alive with no window open: the
 * Glanceboard widget is on an enabled board, or the optional attention watch
 * may wake the glasses for a blocked pane. The app's boot hook spawns the
 * worker whenever this is true; the worker reports idle once it is false.
 */
export function hasHerdrBackgroundWork(): boolean {
  return (isHerdrWidgetInUse() || wakeOnBlockedEnabled()) && loadMachines().some((machine) => machine.enabled);
}
