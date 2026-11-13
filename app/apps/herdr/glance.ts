/**
 * The Herdr pane list as the Glanceboard shows it: the worker builds this from
 * its live machine connections and publishes it through the host's
 * worker-state channel; the widget paints it on the main thread. Plain JSON
 * (it crosses postMessage) with timestamps rather than formatted ages.
 *
 * No NativeScript imports: bundled into the worker as well as the widget.
 */
import { isDoneUnseen, urgency, type PaneRef, type ReadMarkers } from "./model";
import type { AgentStatus } from "./protocol";

/** Worker-state key the Herdr worker publishes its snapshot under. */
export const HERDR_GLANCE_STATE_KEY = "herdr:panes";

/** More than a double-height slot can show; the widget says how many it left out. */
const MAX_ROWS = 24;

export type HerdrGlanceRow = {
  /** machineId|paneId. */
  key: string;
  /** `[machine/]workspace · agent-or-title`. */
  title: string;
  status: AgentStatus;
  /** Done since the wearer last read it. */
  unread: boolean;
  /** The pane is focused in Herdr on its machine, so a wake would be noise. */
  focused: boolean;
  /** Pending queued messages (protocol 3 summaries), when known. */
  queued: number;
};

export type HerdrGlanceSnapshot = {
  /** At least one machine is configured. */
  configured: boolean;
  /** Why there is nothing to show when no machine is connected; "" otherwise. */
  status: string;
  needsYou: number;
  working: number;
  /** Needs-you first, then working, then the rest. */
  rows: HerdrGlanceRow[];
  /** Panes beyond `rows`. */
  more: number;
};

export type HerdrGlanceMachine = {
  id: string;
  label: string;
  enabled: boolean;
  /** HerdrMachineClient phase. */
  phase: string;
  panes: readonly PaneRef[];
};

export function buildGlanceSnapshot(
  machines: readonly HerdrGlanceMachine[],
  markers: ReadMarkers,
  queueCounts: ReadonlyMap<string, number> = new Map(),
): HerdrGlanceSnapshot {
  const refs: PaneRef[] = [];
  for (const machine of machines) {
    if (machine.phase !== "connected") continue;
    for (const ref of machine.panes) refs.push(ref);
  }
  const sorted = [...refs].sort((a, b) => urgency(a, markers) - urgency(b, markers) || a.machine.localeCompare(b.machine) || a.pane.workspace.localeCompare(b.pane.workspace));
  const multi = machines.length > 1;
  const rows = sorted.slice(0, MAX_ROWS).map((ref): HerdrGlanceRow => {
    const agent = ref.pane.agent ?? (ref.pane.title || "shell");
    return {
      key: `${ref.machineId}|${ref.pane.id}`,
      title: `${multi ? `${ref.machine}/` : ""}${ref.pane.workspace} · ${agent}`,
      status: ref.pane.status,
      unread: isDoneUnseen(ref, markers),
      focused: ref.pane.focused === true,
      queued: queueCounts.get(`${ref.machineId}|${ref.pane.id}`) ?? 0,
    };
  });
  const needsYou = refs.filter((ref) => ref.pane.status === "blocked" || isDoneUnseen(ref, markers)).length;
  return {
    configured: machines.length > 0,
    status: machinesStatus(machines),
    needsYou,
    working: refs.filter((ref) => ref.pane.status === "working").length,
    rows,
    more: Math.max(0, sorted.length - rows.length),
  };
}

function machinesStatus(machines: readonly HerdrGlanceMachine[]): string {
  if (!machines.length) return "";
  if (machines.every((machine) => !machine.enabled)) return "Disconnected";
  if (machines.some((machine) => machine.phase === "connected")) return "";
  if (machines.some((machine) => machine.phase === "connecting" || machine.phase === "retrying")) return "Connecting…";
  if (machines.every((machine) => machine.phase === "forbidden")) return "Bridge refused this phone";
  return "Can't reach the bridge";
}

/** "1 needs you · 2 working" (or "" when neither). */
export function glanceSummary(snapshot: Pick<HerdrGlanceSnapshot, "needsYou" | "working">): string {
  return [
    snapshot.needsYou ? `${snapshot.needsYou} need${snapshot.needsYou === 1 ? "s" : ""} you` : "",
    snapshot.working ? `${snapshot.working} working` : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The panes a wake may be about. A new blocked event on a pane focused in
 * Herdr on its machine is ignored, matching Claude Code Remote Control's
 * typing-presence rule.
 */
export function wakeCandidates(refs: readonly PaneRef[]): PaneRef[] {
  return refs
    .filter((ref) => ref.pane.status === "blocked" && ref.pane.focused !== true)
    .sort((a, b) => a.machine.localeCompare(b.machine) || a.pane.workspace.localeCompare(b.pane.workspace) || a.pane.id.localeCompare(b.pane.id, undefined, { numeric: true }));
}
