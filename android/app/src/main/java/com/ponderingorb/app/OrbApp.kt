package com.ponderingorb.app

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import java.util.concurrent.TimeUnit

class OrbApp : Application() {
    override fun onCreate() {
        super.onCreate()
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_ALERTS, "Alerts", NotificationManager.IMPORTANCE_DEFAULT).apply { description = "The morning brief, new requests, finished downloads, stuck writes." })
        nm.createNotificationChannel(NotificationChannel(CH_URGENT, "Services down", NotificationManager.IMPORTANCE_HIGH).apply { description = "A service going down or Orb not reaching Uptime Kuma." })
        if (Store(this).signedIn) schedule(this)
    }

    companion object {
        const val CH_ALERTS = "alerts"
        const val CH_URGENT = "urgent"
        private const val PERIODIC = "orb-check"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        /** Every 15 minutes (Android's shortest) while signed in. No Google push: nothing goes through the cloud. */
        fun schedule(c: Context) {
            WorkManager.getInstance(c).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
                PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES).setConstraints(online).build())
        }
        fun checkNow(c: Context, doneTask: String? = null) {
            val req = OneTimeWorkRequestBuilder<SyncWorker>().setConstraints(online)
            if (doneTask != null) req.setInputData(Data.Builder().putString(SyncWorker.DONE, doneTask).build())
            WorkManager.getInstance(c).enqueueUniqueWork(if (doneTask != null) "orb-done-$doneTask" else "orb-now", ExistingWorkPolicy.REPLACE, req.build())
        }
        fun stop(c: Context) { WorkManager.getInstance(c).cancelUniqueWork(PERIODIC) }

        fun openOrb(c: Context, hash: String = ""): PendingIntent = PendingIntent.getActivity(c, hash.hashCode(),
            Intent(c, MainActivity::class.java).putExtra(MainActivity.HASH, hash).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        fun notify(c: Context, a: Alert) {
            if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return
            val hash = when (a.event) { "uptime" -> "uptime"; "brief" -> "daily"; "outbox" -> "config"; else -> "main" }
            // The lock screen shows that Orb has an alert, not what it says.
            val public = NotificationCompat.Builder(c, if (a.priority >= 4) CH_URGENT else CH_ALERTS).setSmallIcon(R.drawable.ic_stat_orb).setContentTitle("Pondering Orb").setContentText("New alert").build()
            val n = NotificationCompat.Builder(c, if (a.priority >= 4) CH_URGENT else CH_ALERTS)
                .setSmallIcon(R.drawable.ic_stat_orb).setColor(0xFF5A3FC0.toInt())
                .setContentTitle(a.title).setContentText(a.message).setStyle(NotificationCompat.BigTextStyle().bigText(a.message))
                .setWhen(a.at).setShowWhen(true).setAutoCancel(true).setContentIntent(openOrb(c, hash))
                .setVisibility(NotificationCompat.VISIBILITY_PRIVATE).setPublicVersion(public)
                .setGroup("orb-alerts").build()
            try { NotificationManagerCompat.from(c).notify(a.id.hashCode(), n) } catch (e: SecurityException) { /* permission taken away */ }
        }
        fun notifyText(c: Context, id: Int, title: String, text: String) {
            if (!NotificationManagerCompat.from(c).areNotificationsEnabled()) return
            val n = NotificationCompat.Builder(c, CH_ALERTS).setSmallIcon(R.drawable.ic_stat_orb).setContentTitle(title).setContentText(text)
                .setAutoCancel(true).setContentIntent(openOrb(c)).build()
            try { NotificationManagerCompat.from(c).notify(id, n) } catch (e: SecurityException) { }
        }
    }
}
