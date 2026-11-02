import { type GrayImage, type UiFont } from "../../../graphics/image";
import { truncateText } from "../../../graphics/textwrap";
import { lineStep } from "../../../ui/metrics";
import { onWorkerStateChanged, readWorkerState } from "../../../ui/shell/worker-state";
import { glanceSummary, HERDR_GLANCE_STATE_KEY, type HerdrGlanceRow, type HerdrGlanceSnapshot } from "../../herdr/glance";
import { glanceFont } from "../glance-font";
import { type GlanceWidget } from "../widget";

const PAD = 8;
/** A row fits while its glyph line clears this margin above the bottom edge. */
const BOTTOM_MARGIN = 2;
const MINUTE_MS = 60_000;

/**
 * Herdr's panes at a glance: how many need you and how many are working, then
 * the panes in the worker's order (needs-you, then working, then the rest) with
 * a status mark. Blocked panes and pending queued messages say so at the right
 * edge. Painted from the snapshot the Herdr worker publishes; the app's boot
 * hook keeps that worker connected while this widget is on an enabled board.
 */
export class HerdrWidget implements GlanceWidget {
  private snapshot = readWorkerState(HERDR_GLANCE_STATE_KEY) as HerdrGlanceSnapshot | undefined;
  private unsubscribe: (() => void) | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;

  start(requestRender: () => void): void {
    this.stop();
    this.snapshot = readWorkerState(HERDR_GLANCE_STATE_KEY) as HerdrGlanceSnapshot | undefined;
    this.unsubscribe = onWorkerStateChanged(HERDR_GLANCE_STATE_KEY, (snapshot) => {
      this.snapshot = snapshot as HerdrGlanceSnapshot | undefined;
      requestRender();
    });
    // Rows carry no timestamps, but the needs-you and working counts still
    // change as panes move on, so repaint each minute rather than only on a
    // publication the board may have missed.
    this.tick = setInterval(requestRender, MINUTE_MS);
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.tick !== null) clearInterval(this.tick);
    this.tick = null;
  }

  paint(image: GrayImage): void {
    const font = glanceFont.small();
    const step = lineStep(font);
    const textWidth = image.width - 2 * PAD;
    const snapshot = this.snapshot;
    let y = PAD;

    const title = "Herdr";
    image.drawText(font, PAD, y, title, 150);
    const summary = snapshot ? glanceSummary(snapshot) : "";
    if (summary) {
      const text = truncateText(font, summary, textWidth - font.measureText(title) - 12);
      image.drawText(font, image.width - PAD - font.measureText(text), y, text, snapshot!.needsYou ? 230 : 140);
    }
    y += step;

    const message = !snapshot
      ? "Open the Herdr app to connect"
      : !snapshot.configured
        ? "Add a bridge in the Herdr app"
        : snapshot.status || (!snapshot.rows.length ? "No panes" : "");
    if (message) {
      image.drawText(font, PAD, y, truncateText(font, message, textWidth), 120);
      return;
    }

    const rows = snapshot!.rows;
    // Rows are placed a line step apart but only need their line height to fit.
    const capacity = Math.max(0, Math.floor((image.height - BOTTOM_MARGIN - y - font.lineHeight) / step) + 1);
    const hidden = rows.length + snapshot!.more - capacity;
    const shown = hidden > 0 ? rows.slice(0, Math.max(0, capacity - 1)) : rows;
    const markerWidth = font.measureText("W") + 7;
    for (const row of shown) {
      paintRow(image, font, row, PAD, y, textWidth, markerWidth);
      y += step;
    }
    if (hidden > 0) {
      image.drawText(font, PAD + markerWidth, y, `+${rows.length + snapshot!.more - shown.length} more`, 110);
    }
  }
}

function rowMarker(row: HerdrGlanceRow): { marker: string; value: number } {
  if (row.status === "blocked") return { marker: "!", value: 255 };
  if (row.unread) return { marker: "●", value: 220 };
  if (row.status === "working") return { marker: "~", value: 200 };
  return { marker: "·", value: 110 };
}

function rowRightText(row: HerdrGlanceRow): string {
  if (row.status === "blocked") return "blocked";
  if (row.queued > 0) return `${row.queued} queued`;
  return "";
}

function paintRow(image: GrayImage, font: UiFont, row: HerdrGlanceRow, x: number, y: number, width: number, markerWidth: number): void {
  const { marker, value: markerValue } = rowMarker(row);
  // A pane focused in Herdr on its machine is already in front of the wearer,
  // so it is drawn dimmer than the panes that are not.
  const dim = row.focused ? 0.6 : 1;
  if (marker) image.drawText(font, x, y, marker, Math.round(markerValue * dim));
  const needsYou = row.status === "blocked";
  const right = rowRightText(row);
  const rightWidth = right ? font.measureText(right) + 8 : 0;
  if (right) image.drawText(font, x + width - font.measureText(right), y, right, Math.round((needsYou ? 230 : 110) * dim));
  const value = needsYou ? 255 : row.status === "working" || row.unread ? 215 : 165;
  image.drawText(font, x + markerWidth, y, truncateText(font, row.title, Math.max(10, width - markerWidth - rightWidth)), Math.round(value * dim));
}
