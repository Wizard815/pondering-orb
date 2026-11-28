package com.ponderingorb.app

import org.json.JSONArray
import org.json.JSONObject

/** Orb's /api/glance: the small summary the widgets, the tile and the offline view show. */
data class Glance(
    val at: Long,
    val day: String,
    val upTotal: Int?,              // null: Uptime Kuma isn't set up
    val down: List<String>,
    val events: List<Event>,
    val tasks: List<Task>,
    val chores: List<String>,
    val brief: String?,
    val media: List<Media>,
    val alerts: Int,
) {
    data class Event(val time: String, val title: String)
    data class Task(val id: String, val title: String, val due: String, val overdue: Boolean)
    data class Media(val name: String, val line: String)

    /** One line for the status widget and the quick tile. */
    val statusLine: String get() = when {
        down.size == 1 -> "${down[0]} is down"
        down.size > 1 -> "${down.size} services down"
        upTotal != null -> "All $upTotal up"
        else -> "Orb"
    }

    companion object {
        fun parse(text: String): Glance = from(JSONObject(text))
        fun from(o: JSONObject): Glance {
            val up = o.optJSONObject("uptime")
            return Glance(
                at = o.optLong("at"),
                day = o.optString("day"),
                upTotal = up?.optInt("total"),
                down = up?.optJSONArray("down").strings(),
                events = o.optJSONArray("events").objects().map { Event(it.optString("time"), it.optString("title")) },
                tasks = o.optJSONArray("tasks").objects().map { Task(it.optString("id"), it.optString("title"), it.optString("due"), it.optBoolean("overdue")) },
                chores = o.optJSONArray("chores").objects().map { it.optString("name") },
                brief = o.optJSONObject("brief")?.optString("headline")?.takeIf { it.isNotBlank() },
                media = o.optJSONArray("media").objects().map { Media(it.optString("name"), it.optString("line")) },
                alerts = o.optInt("alerts"),
            )
        }
    }
}

data class Alert(val id: String, val at: Long, val event: String, val title: String, val message: String, val priority: Int) {
    companion object {
        fun from(o: JSONObject) = Alert(o.optString("id"), o.optLong("at"), o.optString("event"), o.optString("title"), o.optString("message"), o.optInt("priority", 3))
    }
}

/** Which new alerts get a notification: the last few, so a backlog doesn't flood the shade. */
fun toNotify(alerts: List<Alert>, max: Int = 3): Pair<List<Alert>, Int> = alerts.takeLast(max) to maxOf(0, alerts.size - max)

fun JSONArray?.objects(): List<JSONObject> = if (this == null) emptyList() else (0 until length()).mapNotNull { optJSONObject(it) }
fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }
