/**
 * Herdr app settings that are small enough to live in the settings store:
 * per-pane read markers, the optional wake-on-blocked switch, and the shared
 * drafts. Machine records live in machines.ts; everything bigger stays in
 * the bridge (queues) or on the device as bounded UI state.
 */
import { getBooleanSetting, getStringSetting, setBooleanSetting, setStringSetting } from "../../native/settings-store";
import { pruneReadMarkers, type PaneRef, type ReadMarkers } from "./model";

export const HERDR_READ_MARKERS_KEY = "herdr.readMarkers";
export const HERDR_WAKE_ON_BLOCKED_KEY = "herdr.wakeOnBlocked";

export function loadReadMarkers(): ReadMarkers {
  const raw = getStringSetting(HERDR_READ_MARKERS_KEY, "");
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const markers: ReadMarkers = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "number" && Number.isFinite(value)) markers[key] = value;
    }
    return markers;
  } catch {
    return {};
  }
}

export function saveReadMarkers(markers: ReadMarkers, refs: readonly PaneRef[]): void {
  setStringSetting(HERDR_READ_MARKERS_KEY, JSON.stringify(pruneReadMarkers(markers, refs)));
}

export function wakeOnBlockedEnabled(): boolean {
  return getBooleanSetting(HERDR_WAKE_ON_BLOCKED_KEY, false);
}

export function setWakeOnBlocked(enabled: boolean): void {
  setBooleanSetting(HERDR_WAKE_ON_BLOCKED_KEY, enabled);
}
