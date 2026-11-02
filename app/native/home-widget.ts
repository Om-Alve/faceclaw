import { Utils } from "@nativescript/core";

import { homeWidgetSnapshot, type HomeWidgetInput } from "./home-widget-model";

declare const com: any;

/**
 * Bridge to the Android home widget (FaceclawHomeWidget / FaceclawHomeWidgetProvider).
 *
 * The controller calls this on every state change, but the widget only cares
 * about pairing, connection, battery, case and frame. Comparing the snapshot
 * here means a menu repainting does not cost a native call, and the call only
 * happens when the tile would change.
 *
 * No-op on iOS: the widget is Android-only.
 */

/**
 * While connected, republish unchanged data at least this often. The widget
 * draws a connected snapshot older than 15 minutes as offline (the app died).
 */
const HOME_WIDGET_HEARTBEAT_MS = 5 * 60_000;

let lastPublished = "";
let lastPublishedAtMs = 0;

export function publishHomeWidget(input: HomeWidgetInput): void {
  if (!global.isAndroid) return;
  const snapshot = homeWidgetSnapshot(input);
  const json = JSON.stringify(snapshot);
  const now = Date.now();
  const heartbeatDue = snapshot.connected && now - lastPublishedAtMs >= HOME_WIDGET_HEARTBEAT_MS;
  if (json === lastPublished && !heartbeatDue) return;
  const context = Utils.android.getApplicationContext();
  if (!context) return;
  try {
    com.faceclaw.app.FaceclawHomeWidget.publish(context, json);
    lastPublished = json;
    lastPublishedAtMs = now;
  } catch (error) {
    console.warn(`home widget publish failed: ${String((error as Error)?.message ?? error)}`);
  }
}
