package com.ponderingorb.app

import android.content.Context
import android.service.quicksettings.TileService
import android.content.ComponentName
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/** The background check: ticks off a task (from the Tasks widget) if asked, then fetches the
 *  glance (widgets, tile, offline view) and new alerts (notifications). */
class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        val c = applicationContext
        val store = Store(c)
        if (!store.signedIn) return@withContext Result.success()
        val api = store.api()
        try {
            inputData.getString(DONE)?.let { api.done(it) }
            val (g, raw) = api.glance()
            store.glanceJson = raw; store.lastError = ""
            val seen = store.alertsSeen
            val (now, alerts) = api.alerts(if (seen < 0) System.currentTimeMillis() else seen)
            // The first check only notes the time, so a new install doesn't replay old alerts.
            store.alertsSeen = alerts.lastOrNull()?.at ?: if (seen < 0) now else seen
            if (seen >= 0 && alerts.isNotEmpty() && store.notifications) {
                val (show, more) = toNotify(alerts)
                show.forEach { OrbApp.notify(c, it) }
                if (more > 0) OrbApp.notifyText(c, 1, "Pondering Orb", "$more more ${if (more == 1) "alert" else "alerts"} while the phone was away.")
            }
            Widgets.updateAll(c, g)
            Result.success()
        } catch (e: SignedOut) {
            store.signOut(); OrbApp.stop(c); store.lastError = e.message ?: ""
            Widgets.updateAll(c, null)
            Result.success()
        } catch (e: OrbError) {
            store.lastError = e.message ?: ""
            Widgets.updateAll(c, store.glance)
            Result.success()      // the next check tries again; no retry storm on a dead tunnel
        } finally {
            TileService.requestListeningState(c, ComponentName(c, OrbTileService::class.java))
        }
    }
    companion object { const val DONE = "done" }
}
