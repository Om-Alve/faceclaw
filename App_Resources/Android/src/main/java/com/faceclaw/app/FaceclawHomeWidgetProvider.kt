package com.faceclaw.app

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle

/** Entry point Android calls for the 2x2 home widget; painting lives in FaceclawHomeWidget. */
class FaceclawHomeWidgetProvider : AppWidgetProvider() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == FaceclawHomeWidget.ACTION_STALE_CHECK) {
            // Faceclaw stopped reporting while connected; repaint so the tile goes grey.
            FaceclawHomeWidget.refreshAll(context)
            return
        }
        super.onReceive(context, intent)
    }

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        for (id in appWidgetIds) {
            FaceclawHomeWidget.render(context, appWidgetManager, id)
        }
    }

    /** Resizing changes the number and label sizes, which are fitted to the width. */
    override fun onAppWidgetOptionsChanged(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetId: Int,
        newOptions: Bundle,
    ) {
        FaceclawHomeWidget.render(context, appWidgetManager, appWidgetId)
    }
}
