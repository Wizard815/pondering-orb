package com.ponderingorb.app

import android.view.View
import android.widget.FrameLayout
import app.cash.paparazzi.DeviceConfig
import app.cash.paparazzi.Paparazzi
import org.junit.Rule
import org.junit.Test

/** Pictures of the widgets as they look on a home screen, drawn on the computer
 *  (./gradlew recordPaparazziDebug; they land in src/test/snapshots). */
class ScreensTest {
    @get:Rule val paparazzi = Paparazzi(deviceConfig = DeviceConfig.PIXEL_6.copy(nightMode = com.android.resources.NightMode.NIGHT), showSystemUi = false)

    private val g = Glance.parse(SAMPLE)
    private fun host(vararg views: Pair<View, Int>): View {
        val c = paparazzi.context
        val col = android.widget.LinearLayout(c).apply { orientation = android.widget.LinearLayout.VERTICAL; setPadding(24, 48, 24, 24); setBackgroundColor(0xFF2B3A4A.toInt()) }
        for ((v, h) in views) col.addView(FrameLayout(c).apply { addView(v) }, android.widget.LinearLayout.LayoutParams(-1, (h * c.resources.displayMetrics.density).toInt()).apply { bottomMargin = 36 })
        return col
    }
    private fun apply(w: OrbWidget) = w.preview(paparazzi.context, g, "just now").apply(paparazzi.context, null)

    @Test fun widgets() {
        val status = apply(StatusWidget())
        val today = apply(TodayWidget())
        val media = apply(MediaWidget())
        val tasks = paparazzi.inflate<View>(R.layout.widget_tasks).also { v ->
            v.findViewById<android.widget.TextView>(R.id.updated).text = "just now"
            val list = v.findViewById<android.widget.ListView>(R.id.list)
            list.adapter = object : android.widget.BaseAdapter() {
                override fun getCount() = g.tasks.size
                override fun getItem(i: Int) = g.tasks[i]
                override fun getItemId(i: Int) = i.toLong()
                override fun getView(i: Int, convert: View?, parent: android.view.ViewGroup): View = paparazzi.inflate<View>(R.layout.widget_task_item).also { r ->
                    r.findViewById<android.widget.TextView>(R.id.title).text = g.tasks[i].title
                    r.findViewById<android.widget.TextView>(R.id.due).text = if (g.tasks[i].due.isBlank()) "" else "overdue · ${g.tasks[i].due}"
                    r.findViewById<android.widget.TextView>(R.id.due).setTextColor(0xFFE8796C.toInt())
                }
            }
        }
        paparazzi.snapshot(host(status to 90, today to 170, tasks to 170, media to 100))
    }
}
