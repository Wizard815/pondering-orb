package com.ponderingorb.app

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService

/** Home-screen widgets. They show the last glance (fetched every 15 minutes, on ↻, and when
 *  Orb is open) and never hold the key themselves: taps go through the app. */
object Widgets {
    val providers = listOf(StatusWidget::class.java, TodayWidget::class.java, TasksWidget::class.java, MediaWidget::class.java)

    fun updateAll(c: Context, g: Glance?) {
        val m = AppWidgetManager.getInstance(c)
        for (p in providers) {
            val ids = m.getAppWidgetIds(ComponentName(c, p))
            if (ids.isEmpty()) continue
            val w = p.getDeclaredConstructor().newInstance() as OrbWidget
            for (id in ids) m.updateAppWidget(id, w.views(c, g, id))
            if (p == TasksWidget::class.java) m.notifyAppWidgetViewDataChanged(ids, R.id.list)
        }
    }

    fun refreshIntent(c: Context): PendingIntent = PendingIntent.getBroadcast(c, 1, Intent(c, StatusWidget::class.java).setAction(ACTION_REFRESH), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    const val ACTION_REFRESH = "com.ponderingorb.app.REFRESH"
    const val ACTION_DONE = "com.ponderingorb.app.DONE"

    /** "updated 5 min ago", or why it's old. */
    fun freshness(c: Context, g: Glance?): String {
        val s = Store(c)
        if (!s.signedIn) return "Open Orb to sign in"
        if (s.lastError.isNotBlank()) return s.lastError.substringBefore(". ").take(60)
        if (g == null) return "Not checked yet"
        val m = ((System.currentTimeMillis() - g.at) / 60000).toInt()
        return when { m < 1 -> "just now"; m < 60 -> "$m min ago"; m < 1440 -> "${m / 60} h ago"; else -> "${m / 1440} d ago" }
    }
}

abstract class OrbWidget : AppWidgetProvider() {
    abstract val layout: Int
    abstract val hash: String       // the Orb page a tap opens
    /** The widget's content (texts and colours); the taps are added in views(). */
    abstract fun fill(v: RemoteViews, c: Context, g: Glance?, id: Int)

    fun preview(c: Context, g: Glance?, fresh: String) = RemoteViews(c.packageName, layout).also { v -> v.setTextViewText(R.id.updated, fresh); fill(v, c, g, 0) }
    fun views(c: Context, g: Glance?, id: Int) = RemoteViews(c.packageName, layout).also { v ->
        v.setTextViewText(R.id.updated, Widgets.freshness(c, g))
        fill(v, c, g, id)
        v.setOnClickPendingIntent(R.id.root, OrbApp.openOrb(c, hash))
        v.setOnClickPendingIntent(R.id.refresh, Widgets.refreshIntent(c))
        if (this is TasksWidget) tasksList(v, c, id)
    }

    override fun onUpdate(c: Context, m: AppWidgetManager, ids: IntArray) {
        val g = Store(c).glance
        for (id in ids) m.updateAppWidget(id, views(c, g, id))
        if (Store(c).signedIn) OrbApp.checkNow(c)
    }
    override fun onReceive(c: Context, intent: Intent) {
        super.onReceive(c, intent)
        when (intent.action) {
            Widgets.ACTION_REFRESH -> OrbApp.checkNow(c)
            Widgets.ACTION_DONE -> {
                val id = intent.getStringExtra("task") ?: return
                // Tick it off here at once; the check sends it to Orb and brings back the new list.
                val s = Store(c)
                s.glance?.let { g -> s.glanceJson = withoutTask(s.glanceJson, id); Widgets.updateAll(c, s.glance) }
                OrbApp.checkNow(c, id)
            }
        }
    }
}

fun withoutTask(glanceJson: String, id: String): String = try {
    val o = org.json.JSONObject(glanceJson)
    val t = o.optJSONArray("tasks") ?: return glanceJson
    val keep = org.json.JSONArray()
    for (i in 0 until t.length()) t.optJSONObject(i)?.let { if (it.optString("id") != id) keep.put(it) }
    o.put("tasks", keep).toString()
} catch (e: Exception) { glanceJson }

/** Services: "All 14 up" in green, or what's down in red. 2×1. */
class StatusWidget : OrbWidget() {
    override val layout = R.layout.widget_status
    override val hash = "uptime"
    override fun fill(v: RemoteViews, c: Context, g: Glance?, id: Int) {
        v.setTextViewText(R.id.status, g?.statusLine ?: "Orb")
        v.setTextColor(R.id.status, if (g?.down?.isNotEmpty() == true) Color.parseColor("#E8796C") else Color.parseColor("#7CC48F"))
        v.setTextViewText(R.id.detail, when {
            g == null -> ""
            g.down.size > 1 -> g.down.joinToString(", ")
            g.alerts > 0 -> "${g.alerts} ${if (g.alerts == 1) "alert" else "alerts"} today"
            else -> "No alerts today"
        })
    }
}

/** Today: the brief's first line, events and chores due. 4×2. */
class TodayWidget : OrbWidget() {
    override val layout = R.layout.widget_today
    override val hash = "daily"
    override fun fill(v: RemoteViews, c: Context, g: Glance?, id: Int) {
        v.setTextViewText(R.id.brief, g?.brief ?: if (g == null) "Orb's day shows here after the first check." else "No brief yet today.")
        val lines = buildList {
            g?.events?.take(4)?.forEach { add("${it.time.ifBlank { "all day" }}  ${it.title}") }
            if (g != null && g.events.isEmpty()) add("Nothing on the calendar")
            if (!g?.chores.isNullOrEmpty()) add("Chores due: ${g!!.chores.joinToString(", ")}")
            if (g?.down?.isNotEmpty() == true) add("⚠ ${g.statusLine}")
        }
        v.setTextViewText(R.id.lines, lines.joinToString("\n"))
    }
}

/** Tasks, with a tick to finish one. 4×2 and up, scrolls. */
class TasksWidget : OrbWidget() {
    override val layout = R.layout.widget_tasks
    override val hash = "todo"
    override fun fill(v: RemoteViews, c: Context, g: Glance?, id: Int) {
        v.setTextViewText(R.id.empty, if (g == null) "Tasks show here after the first check." else "No open tasks. Nice.")
    }
    fun tasksList(v: RemoteViews, c: Context, id: Int) {
        val svc = Intent(c, TasksWidgetService::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)
        svc.data = Uri.parse(svc.toUri(Intent.URI_INTENT_SCHEME))
        v.setRemoteAdapter(R.id.list, svc)
        v.setEmptyView(R.id.list, R.id.empty)
        // Each row fills in its task id; the tick sends it here (mutable: the row adds the id).
        v.setPendingIntentTemplate(R.id.list, PendingIntent.getBroadcast(c, 2, Intent(c, TasksWidget::class.java).setAction(Widgets.ACTION_DONE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE))
    }
}

class TasksWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory = object : RemoteViewsFactory {
        var tasks: List<Glance.Task> = emptyList()
        override fun onCreate() {}
        override fun onDataSetChanged() { tasks = Store(applicationContext).glance?.tasks ?: emptyList() }
        override fun onDestroy() {}
        override fun getCount() = tasks.size
        override fun getViewAt(i: Int): RemoteViews = RemoteViews(packageName, R.layout.widget_task_item).also { v ->
            val t = tasks.getOrNull(i) ?: return@also
            v.setTextViewText(R.id.title, t.title)
            v.setTextViewText(R.id.due, if (t.due.isBlank()) "" else (if (t.overdue) "overdue · " else "due ") + t.due)
            v.setViewVisibility(R.id.due, if (t.due.isBlank()) View.GONE else View.VISIBLE)
            v.setTextColor(R.id.due, if (t.overdue) Color.parseColor("#E8796C") else Color.parseColor("#A39D8C"))
            v.setContentDescription(R.id.tick, "Tick off: ${t.title}")
            v.setOnClickFillInIntent(R.id.tick, Intent().putExtra("task", t.id))
        }
        override fun getLoadingView(): RemoteViews? = null
        override fun getViewTypeCount() = 1
        override fun getItemId(i: Int) = tasks.getOrNull(i)?.id?.hashCode()?.toLong() ?: i.toLong()
        override fun hasStableIds() = true
    }
}

/** Media: one line per media widget in Orb's apps YAML (Plex, Tautulli, SABnzbd, Sonarr, Radarr, Seerr). 4×1 and up. */
class MediaWidget : OrbWidget() {
    override val layout = R.layout.widget_media
    override val hash = "main"
    override fun fill(v: RemoteViews, c: Context, g: Glance?, id: Int) {
        v.setTextViewText(R.id.lines, when {
            g == null -> "Media shows here after the first check."
            g.media.isEmpty() -> "No media widgets in Orb's apps YAML yet."
            else -> g.media.joinToString("\n") { "${it.name}: ${it.line}" }
        })
    }
}
