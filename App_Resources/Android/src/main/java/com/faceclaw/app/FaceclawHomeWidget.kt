package com.faceclaw.app

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.Typeface
import android.os.Build
import android.text.format.DateFormat
import android.text.format.DateUtils
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews

import org.json.JSONObject

import java.util.Date
import java.util.Locale

import kotlin.math.ceil

/**
 * The 2x2 home-screen widget: a header, the paired frame's product render, and
 * the glasses and case readouts (dot-matrix number, ten-dot gauge, label).
 * The design is research/work/faceclaw/design/home-widget/preview.html.
 *
 * The TypeScript side (app/native/home-widget.ts) publishes a small JSON
 * snapshot whenever the battery, case, dock or connection state changes. This
 * class merges it into the stored state and repaints every placed widget from
 * storage, so the tile keeps the last readings after the app process dies.
 *
 * Launchers inflate RemoteViews in a restricted context, where TextView
 * ignores font resources, so all text is drawn here with the real fonts (Doto
 * with round dots, Geist Mono) as white masks in ImageViews. Their colour is a
 * tint from values / values-night, resolved by the launcher, so the tile still
 * follows the system theme without a repaint. RemoteViews has no gestures, so
 * the whole tile is one click: open Faceclaw.
 */
class FaceclawHomeWidget private constructor() {
    /** Mirrors HomeWidgetTone in app/native/home-widget-model.ts. */
    internal enum class Tone { NORMAL, LOW, STALE, UNKNOWN }

    /** Mirrors HomeWidgetSuffix: what follows the number. */
    internal enum class Suffix { PERCENT, BOLT, NONE }

    /** How one side (glasses or case) is drawn. */
    internal data class Level(val percent: Int?, val tone: Tone, val suffix: Suffix) {
        /** Gauge dots to light: round(% / 10), and at least one for any reading. */
        val litDots: Int
            get() = if (percent == null) 0 else ((percent + 5) / 10).coerceIn(1, 10)

        /** A reading that is no longer live keeps its number, in grey, with "%". */
        fun notLive(): Level = if (tone == Tone.UNKNOWN) this else Level(percent, Tone.STALE, Suffix.PERCENT)

        companion object {
            val NONE = Level(null, Tone.UNKNOWN, Suffix.NONE)

            fun parse(json: JSONObject?): Level {
                if (json == null || json.isNull("percent")) return NONE
                val percent = json.optInt("percent", -1).takeIf { it in 0..100 } ?: return NONE
                val tone = when (json.optString("tone")) {
                    "low" -> Tone.LOW
                    "stale" -> Tone.STALE
                    else -> Tone.NORMAL
                }
                val suffix = if (json.optString("suffix") == "bolt") Suffix.BOLT else Suffix.PERCENT
                return Level(percent, tone, suffix)
            }
        }
    }

    private class Side(
        val value: Int,
        val label: Int,
        val labelText: Int,
        val dots: IntArray,
    )

    private class Fonts(val dots: Typeface, val mono: Typeface)

    companion object {
        private const val PREFS_NAME = "faceclaw_home_widget"
        private const val KEY_STATE = "state"

        /**
         * A connected snapshot older than this means Faceclaw stopped reporting
         * (the process died), so the tile is drawn offline. The bridge
         * republishes at least every five minutes while connected.
         */
        private const val STALE_MS = 15 * 60 * 1000L
        internal const val ACTION_STALE_CHECK = "com.faceclaw.app.action.HOME_WIDGET_STALE_CHECK"

        /** The layout's dp values are drawn for this width; other sizes scale from it. */
        private const val REFERENCE_DP = 180f
        private const val PADDING_DP = 16f
        private const val COLUMN_GAP_DP = 12f
        private const val NUMBER_DP = 36f
        private const val LABEL_DP = 9.5f
        private const val LABEL_TRACKING = 0.1f

        /** The "%" and the bolt are drawn at this fraction of the number's size. */
        private const val SUFFIX_RATIO = 0.4f

        /** The bolt's box in suffix ems, and its path in a 10 x 14 box (bottom on the baseline). */
        private const val BOLT_WIDTH_EM = 0.56f
        private const val BOLT_HEIGHT_EM = 0.78f
        private const val BOLT_GAP_EM = 0.06f
        private val BOLT_POINTS = floatArrayOf(6.4f, 0f, 0.6f, 8f, 4.6f, 8f, 3.4f, 14f, 9.4f, 5.6f, 5.4f, 5.6f)

        @Volatile
        private var cachedFonts: Fonts? = null

        private const val ART_ALPHA_LIVE = 255
        private const val ART_ALPHA_OFFLINE = 128
        private const val ART_ALPHA_UNPAIRED = 102

        private val GLASSES = Side(
            R.id.widget_glasses_value,
            R.id.widget_glasses_label,
            R.string.widget_glasses,
            intArrayOf(
                R.id.widget_glasses_dot0, R.id.widget_glasses_dot1, R.id.widget_glasses_dot2,
                R.id.widget_glasses_dot3, R.id.widget_glasses_dot4, R.id.widget_glasses_dot5,
                R.id.widget_glasses_dot6, R.id.widget_glasses_dot7, R.id.widget_glasses_dot8,
                R.id.widget_glasses_dot9,
            ),
        )

        private val CASE = Side(
            R.id.widget_case_value,
            R.id.widget_case_label,
            R.string.widget_case,
            intArrayOf(
                R.id.widget_case_dot0, R.id.widget_case_dot1, R.id.widget_case_dot2,
                R.id.widget_case_dot3, R.id.widget_case_dot4, R.id.widget_case_dot5,
                R.id.widget_case_dot6, R.id.widget_case_dot7, R.id.widget_case_dot8,
                R.id.widget_case_dot9,
            ),
        )

        /** Called from TypeScript with the snapshot built by homeWidgetSnapshot(). */
        @JvmStatic
        fun publish(context: Context, json: String) {
            val app = context.applicationContext
            val incoming = runCatching { JSONObject(json) }.getOrNull() ?: return
            val prefs = app.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
            val previous = prefs.getString(KEY_STATE, null)?.let { runCatching { JSONObject(it) }.getOrNull() }
            val now = System.currentTimeMillis()
            val state = merge(previous, incoming, now)
            prefs.edit().putString(KEY_STATE, state.toString()).apply()
            val placed = refreshAll(app)
            // If the process dies while connected, nothing else would grey the tile.
            if (placed > 0 && state.optBoolean("connected")) scheduleStaleCheck(app, now + STALE_MS + 60_000L)
        }

        /**
         * The stored state after a new snapshot. A side the app has no reading
         * for (it just started, or has not heard from the case this session)
         * keeps the last stored reading as stale, and the last-seen time only
         * moves while connected. Unpairing clears everything.
         */
        private fun merge(previous: JSONObject?, incoming: JSONObject, nowMs: Long): JSONObject {
            val state = JSONObject(incoming.toString())
            state.put("updatedAtMs", nowMs)
            if (!incoming.optBoolean("paired")) return state
            if (incoming.optBoolean("connected")) {
                state.put("seenAtMs", nowMs)
            } else {
                previous?.optLong("seenAtMs", 0L)?.takeIf { it > 0L }?.let { state.put("seenAtMs", it) }
            }
            for (key in arrayOf("glasses", "case")) {
                if (Level.parse(incoming.optJSONObject(key)).percent != null) continue
                val last = Level.parse(previous?.optJSONObject(key)).percent ?: continue
                state.put(key, JSONObject().put("percent", last).put("tone", "stale").put("suffix", "percent"))
            }
            return state
        }

        /** Repaint every placed widget; returns how many there are. */
        internal fun refreshAll(context: Context): Int {
            val manager = AppWidgetManager.getInstance(context)
            val ids = manager.getAppWidgetIds(ComponentName(context, FaceclawHomeWidgetProvider::class.java))
            for (id in ids) render(context, manager, id)
            return ids.size
        }

        internal fun render(context: Context, manager: AppWidgetManager, widgetId: Int) {
            val state = readState(context)
            val now = System.currentTimeMillis()
            val paired = state?.optBoolean("paired", false) == true
            val updatedAt = state?.optLong("updatedAtMs", 0L) ?: 0L
            val live = paired && state?.optBoolean("connected", false) == true && now - updatedAt <= STALE_MS
            var glasses = if (paired) Level.parse(state?.optJSONObject("glasses")) else Level.NONE
            var case = if (paired) Level.parse(state?.optJSONObject("case")) else Level.NONE
            if (!live) {
                glasses = glasses.notLive()
                case = case.notLive()
            }

            val widthDp = manager.getAppWidgetOptions(widgetId)
                .getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH)
                .takeIf { it > 0 }?.toFloat() ?: REFERENCE_DP
            val scale = (widthDp / REFERENCE_DP).coerceIn(0.75f, 1.3f)
            val views = RemoteViews(context.packageName, R.layout.widget_faceclaw)

            val fonts = fonts(context)
            val padding = px(context, PADDING_DP * scale)
            views.setViewPadding(android.R.id.background, padding, padding, padding, padding)
            val labelPx = pxF(context, LABEL_DP * scale)
            views.setImageViewBitmap(R.id.widget_brand, labelMask(context.getString(R.string.widget_brand), fonts, labelPx))
            val status = when {
                !paired -> context.getString(R.string.widget_status_pair)
                live -> null
                else -> lastSeenText(context, state?.optLong("seenAtMs", 0L) ?: 0L)
            }
            views.setViewVisibility(R.id.widget_conn, if (status == null) View.VISIBLE else View.GONE)
            views.setViewVisibility(R.id.widget_status, if (status == null) View.GONE else View.VISIBLE)
            if (status != null) views.setImageViewBitmap(R.id.widget_status, labelMask(status, fonts, labelPx))

            views.setImageViewResource(R.id.widget_art, artFor(state?.optString("frame")))
            views.setInt(
                R.id.widget_art,
                "setImageAlpha",
                when {
                    !paired -> ART_ALPHA_UNPAIRED
                    !live -> ART_ALPHA_OFFLINE
                    else -> ART_ALPHA_LIVE
                },
            )

            // One number size for both columns, fitted to the longer readout, so
            // a "100" never makes one side smaller than the other. Sized in dp, not
            // sp: the tile is a fixed box and must not overflow at large font scales.
            val columnPx = pxF(context, (widthDp - 2f * PADDING_DP * scale - COLUMN_GAP_DP) / 2f)
            val numberPx = numberSize(fonts, columnPx, pxF(context, NUMBER_DP * scale), glasses, case)
            paintSide(context, views, fonts, GLASSES, glasses, numberPx, labelPx)
            paintSide(context, views, fonts, CASE, case, numberPx, labelPx)

            views.setContentDescription(android.R.id.background, describe(context, paired, glasses, case))
            launchIntent(context)?.let { views.setOnClickPendingIntent(android.R.id.background, it) }
            manager.updateAppWidget(widgetId, views)
        }

        private fun paintSide(
            context: Context,
            views: RemoteViews,
            fonts: Fonts,
            side: Side,
            level: Level,
            numberPx: Float,
            labelPx: Float,
        ) {
            views.setImageViewBitmap(side.value, valueMask(fonts, level, numberPx))
            views.setImageViewBitmap(side.label, labelMask(context.getString(side.labelText), fonts, labelPx))
            val tint = when (level.tone) {
                Tone.NORMAL -> R.color.widget_fg
                Tone.LOW -> R.color.widget_red_text
                Tone.STALE, Tone.UNKNOWN -> R.color.widget_stale
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                // Resolved by the launcher, so a light/dark switch needs no repaint.
                views.setColorStateList(side.value, "setImageTintList", tint)
            } else {
                views.setInt(side.value, "setColorFilter", context.getColor(tint))
            }

            val lit = when (level.tone) {
                Tone.LOW -> R.drawable.widget_dot_low
                Tone.STALE -> R.drawable.widget_dot_stale
                else -> R.drawable.widget_dot_on
            }
            side.dots.forEachIndexed { index, id ->
                views.setImageViewResource(id, if (index < level.litDots) lit else R.drawable.widget_dot_off)
            }
        }

        /** Largest number size, up to [maxPx], at which both readouts fit a column. */
        private fun numberSize(fonts: Fonts, columnPx: Float, maxPx: Float, vararg levels: Level): Float {
            val reference = 100f
            val widest = levels.maxOf { valueWidth(fonts, it, reference) }
            return minOf(maxPx, columnPx / widest * reference)
        }

        private fun valueWidth(fonts: Fonts, level: Level, numberPx: Float): Float {
            val number = textPaint(fonts.dots, numberPx).measureText(numberText(level))
            val suffixPx = numberPx * SUFFIX_RATIO
            return number + when (level.suffix) {
                Suffix.PERCENT -> textPaint(fonts.mono, suffixPx).measureText("%")
                Suffix.BOLT -> suffixPx * (BOLT_GAP_EM + BOLT_WIDTH_EM)
                Suffix.NONE -> 0f
            }
        }

        private fun numberText(level: Level): String = level.percent?.toString() ?: "-"

        /**
         * The readout as one white mask: Doto digits, then "%" (Geist Mono) or
         * the bolt, all on the digits' baseline. Doto ships with its line box cut
         * to the digits (res/font/doto_round.ttf), so the mask has no empty band.
         */
        private fun valueMask(fonts: Fonts, level: Level, numberPx: Float): Bitmap {
            val digits = textPaint(fonts.dots, numberPx)
            val metrics = digits.fontMetrics
            val baseline = -metrics.ascent
            val bitmap = mask(valueWidth(fonts, level, numberPx), metrics.descent - metrics.ascent)
            val canvas = Canvas(bitmap)
            val text = numberText(level)
            canvas.drawText(text, 0f, baseline, digits)
            val x = digits.measureText(text)
            val suffixPx = numberPx * SUFFIX_RATIO
            when (level.suffix) {
                Suffix.PERCENT -> canvas.drawText("%", x, baseline, textPaint(fonts.mono, suffixPx))
                Suffix.BOLT -> {
                    val left = x + suffixPx * BOLT_GAP_EM
                    val sx = suffixPx * BOLT_WIDTH_EM / 10f
                    val sy = suffixPx * BOLT_HEIGHT_EM / 14f
                    val top = baseline - suffixPx * BOLT_HEIGHT_EM
                    val bolt = Path()
                    for (i in BOLT_POINTS.indices step 2) {
                        val px = left + BOLT_POINTS[i] * sx
                        val py = top + BOLT_POINTS[i + 1] * sy
                        if (i == 0) bolt.moveTo(px, py) else bolt.lineTo(px, py)
                    }
                    bolt.close()
                    canvas.drawPath(bolt, Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.WHITE })
                }
                Suffix.NONE -> Unit
            }
            return bitmap
        }

        /**
         * An all-caps Geist Mono label as a white mask, cropped to the cap height
         * (measured on "H") so every label is the same height and lines up.
         */
        private fun labelMask(text: String, fonts: Fonts, sizePx: Float): Bitmap {
            val paint = textPaint(fonts.mono, sizePx).apply { letterSpacing = LABEL_TRACKING }
            val caps = text.uppercase(Locale.getDefault())
            val capBounds = Rect().also { paint.getTextBounds("H", 0, 1, it) }
            val inkBounds = Rect().also { paint.getTextBounds(caps, 0, caps.length, it) }
            val top = minOf(capBounds.top, inkBounds.top) - 1
            val bottom = maxOf(0, inkBounds.bottom) + 1
            val bitmap = mask(paint.measureText(caps), (bottom - top).toFloat())
            Canvas(bitmap).drawText(caps, 0f, -top.toFloat(), paint)
            return bitmap
        }

        private fun mask(width: Float, height: Float): Bitmap =
            Bitmap.createBitmap(ceil(width).toInt().coerceAtLeast(1), ceil(height).toInt().coerceAtLeast(1), Bitmap.Config.ARGB_8888)

        private fun textPaint(typeface: Typeface, sizePx: Float): Paint =
            Paint(Paint.ANTI_ALIAS_FLAG).apply {
                this.typeface = typeface
                textSize = sizePx
                color = Color.WHITE
            }

        /** The bundled fonts; before Android 8 font resources cannot be loaded, so monospace stands in. */
        private fun fonts(context: Context): Fonts {
            cachedFonts?.let { return it }
            val loaded = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                val resources = context.applicationContext.resources
                Fonts(resources.getFont(R.font.doto_round), resources.getFont(R.font.geist_mono_medium))
            } else {
                Fonts(Typeface.MONOSPACE, Typeface.MONOSPACE)
            }
            cachedFonts = loaded
            return loaded
        }

        /** The clock time last connected (or the date, if not today), so it never goes out of date. */
        private fun lastSeenText(context: Context, seenAtMs: Long): String {
            if (seenAtMs <= 0L) return context.getString(R.string.widget_status_offline)
            if (DateUtils.isToday(seenAtMs)) return DateFormat.getTimeFormat(context).format(Date(seenAtMs))
            return DateUtils.formatDateTime(
                context,
                seenAtMs,
                DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH or DateUtils.FORMAT_NO_YEAR,
            )
        }

        /** Frame C and unknown serials get the generic G2 render, as in the app. */
        private fun artFor(frame: String?): Int = when (frame) {
            "a" -> R.drawable.widget_glasses_g2_a
            "b" -> R.drawable.widget_glasses_g2_b
            else -> R.drawable.widget_glasses_g2
        }

        /** What TalkBack reads for the tile, e.g. "Glasses 86%, charging. Case 74%, last reading." */
        private fun describe(context: Context, paired: Boolean, glasses: Level, case: Level): String {
            if (!paired) return context.getString(R.string.widget_a11y_not_paired)
            return listOf(GLASSES to glasses, CASE to case).joinToString(separator = ". ", postfix = ".") { (side, level) ->
                val label = context.getString(side.labelText)
                val percent = level.percent
                    ?: return@joinToString context.getString(R.string.widget_a11y_no_reading, label)
                buildString {
                    append(context.getString(R.string.widget_a11y_level, label, percent))
                    if (level.suffix == Suffix.BOLT) append(", ").append(context.getString(R.string.widget_a11y_charging))
                    if (level.tone == Tone.STALE) append(", ").append(context.getString(R.string.widget_a11y_last_reading))
                }
            }
        }

        private fun readState(context: Context): JSONObject? {
            val json = context.applicationContext
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
                .getString(KEY_STATE, null) ?: return null
            return runCatching { JSONObject(json) }.getOrNull()
        }

        /** Inexact and non-waking: the tile only needs to be right once someone looks at it. */
        private fun scheduleStaleCheck(context: Context, atMs: Long) {
            val alarms = context.getSystemService(AlarmManager::class.java) ?: return
            val intent = Intent(context, FaceclawHomeWidgetProvider::class.java).setAction(ACTION_STALE_CHECK)
            val pending = PendingIntent.getBroadcast(
                context,
                0,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
            alarms.set(AlarmManager.RTC, atMs, pending)
        }

        /** The same intent as the launcher icon, so an open Faceclaw comes forward as it was. */
        private fun launchIntent(context: Context): PendingIntent? {
            val launch = context.packageManager.getLaunchIntentForPackage(context.packageName) ?: return null
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
            return PendingIntent.getActivity(
                context,
                0,
                launch,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        private fun px(context: Context, dp: Float): Int = pxF(context, dp).toInt()

        private fun pxF(context: Context, dp: Float): Float =
            TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, context.resources.displayMetrics)
    }
}
