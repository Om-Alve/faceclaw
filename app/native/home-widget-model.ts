/**
 * Pure model for the Android 2x2 home widget: what each side (glasses, case)
 * shows, from the state the dashboard controller already tracks. The design is
 * research/work/faceclaw/design/home-widget/preview.html.
 *
 * Kept free of NativeScript imports so node tests can drive it. The Android
 * renderer (FaceclawHomeWidget.kt) paints this snapshot and owns only what
 * depends on the clock at paint time: a snapshot that stopped arriving is
 * drawn offline, and a side with no reading keeps its last stored one.
 */

/** Under this, a live reading turns red: the widget's only colour. */
export const HOME_WIDGET_LOW_PERCENT = 15;

/** How a number is drawn: white, red (low), grey (not live) or "-" (no reading). */
export type HomeWidgetTone = "normal" | "low" | "stale" | "unknown";

/** What follows the number: "%", the charging bolt, or nothing ("-"). */
export type HomeWidgetSuffix = "percent" | "bolt" | "none";

export type HomeWidgetLevel = {
  percent: number | null;
  tone: HomeWidgetTone;
  suffix: HomeWidgetSuffix;
};

export type HomeWidgetInput = {
  /** Both glasses arms have a saved address. */
  paired: boolean;
  /** The glasses are reachable now (worn or docked), not merely remembered. */
  connected: boolean;
  /** The glasses sit in their case, which is the only time the case reports. */
  docked: boolean;
  /** Last glasses percentage, or null before one arrives. */
  glasses: number | null;
  glassesCharging: boolean | null;
  /** Last case percentage, kept across disconnects. */
  caseBattery: number | null;
  caseCharging: boolean | null;
  /** The paired serial's frame shape (glasses-hardware-identity.ts), or null. */
  frame: string | null;
};

export type HomeWidgetSnapshot = {
  paired: boolean;
  connected: boolean;
  /** Frame A or B selects the render; anything else gets the generic G2. */
  frame: "a" | "b" | null;
  glasses: HomeWidgetLevel;
  case: HomeWidgetLevel;
};

const NO_READING: HomeWidgetLevel = { percent: null, tone: "unknown", suffix: "none" };

/**
 * One side. A reading that is not live is grey with a plain "%" (a charging
 * flag is only true while it is live). A live one is red under 15%, and shows
 * the bolt instead of "%" while charging, red or not.
 */
export function homeWidgetLevel(percent: number | null, charging: boolean | null, live: boolean): HomeWidgetLevel {
  const value = normalizePercent(percent);
  if (value === null) return NO_READING;
  if (!live) return { percent: value, tone: "stale", suffix: "percent" };
  return {
    percent: value,
    tone: value < HOME_WIDGET_LOW_PERCENT ? "low" : "normal",
    suffix: charging ? "bolt" : "percent",
  };
}

/**
 * The published snapshot. The case is live only while the glasses are docked
 * and connected: worn, its number is the reading from the last dock.
 */
export function homeWidgetSnapshot(input: HomeWidgetInput): HomeWidgetSnapshot {
  if (!input.paired) {
    return { paired: false, connected: false, frame: null, glasses: NO_READING, case: NO_READING };
  }
  const connected = Boolean(input.connected);
  return {
    paired: true,
    connected,
    frame: input.frame === "a" || input.frame === "b" ? input.frame : null,
    glasses: homeWidgetLevel(input.glasses, input.glassesCharging, connected),
    case: homeWidgetLevel(input.caseBattery, input.caseCharging, connected && Boolean(input.docked)),
  };
}

function normalizePercent(value: number | null | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 100) return null;
  return Math.round(value);
}
