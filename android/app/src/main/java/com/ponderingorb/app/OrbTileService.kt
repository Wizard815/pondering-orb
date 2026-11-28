package com.ponderingorb.app

import android.annotation.SuppressLint
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService

/** A Quick Settings tile: Orb's status at a swipe ("All 14 up", "Plex is down"); tap opens Orb. */
class OrbTileService : TileService() {
    override fun onStartListening() {
        val t = qsTile ?: return
        val s = Store(this)
        val g = s.glance
        t.label = "Orb"
        val sub = if (!s.signedIn) "Sign in" else g?.statusLine ?: "Not checked yet"
        if (Build.VERSION.SDK_INT >= 29) t.subtitle = sub else t.label = "Orb: $sub"
        t.state = if (g?.down?.isNotEmpty() == true) Tile.STATE_ACTIVE else Tile.STATE_INACTIVE
        t.contentDescription = "Pondering Orb: $sub"
        t.updateTile()
    }
    @SuppressLint("StartActivityAndCollapseDeprecated")
    override fun onClick() {
        if (Build.VERSION.SDK_INT >= 34) startActivityAndCollapse(OrbApp.openOrb(this, if (Store(this).glance?.down?.isNotEmpty() == true) "uptime" else ""))
        else @Suppress("DEPRECATION") startActivityAndCollapse(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }
}
