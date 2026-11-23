/**
 * The terminal session list as it is drawn in two places: the Terminal app's
 * hub window (in the worker) and the Glanceboard's Terminal widget (on the
 * main thread). The worker publishes a snapshot of the list through the
 * host's worker-state channel; both painters use drawSessionRow so a row
 * looks the same in each.
 *
 * No NativeScript imports: this module is bundled into the worker as well.
 */
import { type GrayImage, type UiFont } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import type { SessionStatus } from "../../native/terminal-session-types";

/** Worker-state key the Terminal worker publishes its snapshot under. */
export const TERMINAL_SESSIONS_STATE_KEY = "terminal:sessions";

/** Alternation period of the activity indicator, shared by hub rows, the widget and sidebar cursors. */
export const SESSION_ACTIVITY_STEP_MS = 800;

export type TerminalSessionRow = {
  /** Connection-scoped identity (connection id + socket). */
  key: string;
  label: string;
  /** Local-clock time (Date.now() domain) until which the session counts as active; 0 = idle. */
  activeUntilMs: number;
  /** Sidebar glyph ("1", "2", ...) of the view window showing this session, or null when none is open. */
  openGlyph: string | null;
  status?: SessionStatus;
};

export type TerminalHostGroup = {
  /** Host name, shown as a heading when more than one host is connected. */
  name: string;
  sessions: TerminalSessionRow[];
};

export type TerminalSessionsSnapshot = {
  /** Connected hosts, each with its live sessions most-recently-updated first. */
  hosts: TerminalHostGroup[];
  /** The hub's status line ("Connecting...", "No connections configured.", ...). */
  status: string;
  /** Whether any g2mirror connection is configured at all. */
  configured: boolean;
};

/** Whether a row's activity indicator should show right now. */
export function isSessionRowActive(row: TerminalSessionRow, nowMs = Date.now()): boolean {
  return row.activeUntilMs > nowMs;
}

/** Width of the window-number column (one glyph plus breathing room). */
export function sessionGlyphColumnWidth(font: UiFont): number {
  return font.measureText("W") + 6;
}

/** Left edge of the label in a row whose activity gutter starts at `x`. */
export function sessionLabelX(font: UiFont, x: number): number {
  return x + SESSION_INDICATOR_SIZE + 4 + sessionGlyphColumnWidth(font);
}

const SESSION_INDICATOR_SIZE = 6;

/** Status marks, drawn as shapes like the activity indicator, one string per pixel row ("#" lit). */
const STATUS_MARKS: Record<SessionStatus["state"], readonly string[]> = {
  blocked: [
    "..###..",
    "..###..",
    "..###..",
    "..###..",
    ".......",
    "..###..",
    "..###..",
  ],
  error: [
    "#.....#",
    ".#...#.",
    "..#.#..",
    "...#...",
    "..#.#..",
    ".#...#.",
    "#.....#",
  ],
  done: [
    ".......",
    "......#",
    ".....#.",
    "#...#..",
    ".#.#...",
    "..#....",
    ".......",
  ],
  working: [
    ".......",
    ".......",
    ".......",
    ".......",
    ".......",
    "#..#..#",
    "#..#..#",
  ],
};
const STATUS_MARK_SIZE = STATUS_MARKS.blocked.length;
/** Space before the status mark, and between the label and a blocked message. */
const STATUS_GAP = 6;
/** The blocked mark is always at full brightness, so it stands out on an unselected row. */
const STATUS_BLOCKED_VALUE = 255;
/** How much dimmer than the label the working mark and the blocked message draw. */
const STATUS_DIM = 60;
/** A blocked message is left out when fewer than this many characters of it would fit. */
const BLOCKED_MSG_MIN_CHARS = 4;

/**
 * One session row: the activity indicator in the gutter at `x` (a small
 * square, filled on even animation phases and outlined on odd ones, drawn as
 * shapes rather than a font glyph so both states read in every UI font),
 * then the open view window's glyph in its own column, then the label,
 * truncated (never wrapped) to fit `width`. A row with a status ends in its
 * mark, and a blocked row shows its message, dimmer, after the label when
 * there is room left.
 */
export function drawSessionRow(
  image: GrayImage,
  font: UiFont,
  options: {
    x: number;
    /** Top of the text line. */
    y: number;
    /** Horizontal room from `x`, label included. */
    width: number;
    label: string;
    openGlyph: string | null;
    active: boolean;
    /** Animation phase (0 = filled indicator). */
    phase: number;
    /** Text brightness for the label (the glyph draws a little dimmer). */
    value: number;
    status?: SessionStatus;
  },
): void {
  const { x, y, width, label, openGlyph, active, phase, value, status } = options;
  if (active) {
    const iy = y + Math.max(0, ((font.lineHeight - SESSION_INDICATOR_SIZE) / 2) | 0);
    if (phase % 2 === 0) {
      image.fillRect(x, iy, SESSION_INDICATOR_SIZE, SESSION_INDICATOR_SIZE, value);
    } else {
      image.drawRect(x, iy, SESSION_INDICATOR_SIZE, SESSION_INDICATOR_SIZE, value);
    }
  }
  if (openGlyph) {
    image.drawText(font, x + SESSION_INDICATOR_SIZE + 4, y, openGlyph, Math.max(0, value - 60));
  }
  const labelX = sessionLabelX(font, x);
  const textRight = status ? x + width - STATUS_MARK_SIZE - STATUS_GAP : x + width;
  const shown = truncateText(font, label, Math.max(0, textRight - labelX));
  image.drawText(font, labelX, y, shown, value);
  if (!status) return;
  drawStatusMark(image, x + width - STATUS_MARK_SIZE, y + Math.max(0, ((font.lineHeight - STATUS_MARK_SIZE) / 2) | 0), status.state, value);
  const msgX = labelX + font.measureText(shown) + STATUS_GAP;
  const msgWidth = textRight - msgX;
  if (status.state === "blocked" && status.msg && msgWidth >= font.measureText("W".repeat(BLOCKED_MSG_MIN_CHARS))) {
    image.drawText(font, msgX, y, truncateText(font, status.msg, msgWidth), Math.max(0, value - STATUS_DIM));
  }
}

function drawStatusMark(image: GrayImage, x: number, y: number, state: SessionStatus["state"], value: number): void {
  const lit = state === "blocked" ? STATUS_BLOCKED_VALUE : state === "working" ? Math.max(0, value - STATUS_DIM) : value;
  STATUS_MARKS[state].forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) if (row[dx] === "#") image.setPixel(x + dx, y + dy, lit);
  });
}
