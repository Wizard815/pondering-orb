package com.ponderingorb.app

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.Switch
import android.widget.TextView
import java.util.concurrent.Executors

/** Sign in once with Orb's password (the phone gets its own key), and the app's own settings. */
class AccountActivity : Activity() {
    private lateinit var store: Store
    private val io = Executors.newSingleThreadExecutor()
    private fun <T : View> v(id: Int): T = findViewById(id)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        setContentView(R.layout.activity_account)
        intent.getStringExtra(MESSAGE)?.let { error(it) } ?: store.lastError.takeIf { !store.signedIn && it.isNotBlank() }?.let { error(it) }
        v<EditText>(R.id.url).setText(store.baseUrl)
        v<EditText>(R.id.name).setText(store.deviceName.ifBlank { "${Build.MANUFACTURER.replaceFirstChar { it.uppercase() }} ${Build.MODEL}".take(60) })
        v<EditText>(R.id.cf_id).setText(store.cfClientId)
        v<Button>(R.id.sign_in).setOnClickListener { signIn() }
        v<Button>(R.id.open).setOnClickListener { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP)); finish() }
        v<Button>(R.id.sign_out).setOnClickListener { signOut() }
        v<Button>(R.id.save).setOnClickListener { save() }
        v<Switch>(R.id.notifications).setOnCheckedChangeListener { _, on -> store.notifications = on }
        show()
    }

    private fun show() {
        val inn = store.signedIn
        v<View>(R.id.signin_box).visibility = if (inn) View.GONE else View.VISIBLE
        v<View>(R.id.signed_box).visibility = if (inn) View.VISIBLE else View.GONE
        if (inn) {
            v<TextView>(R.id.where).text = "Connected to ${store.baseUrl} as ${store.deviceName}."
            v<Switch>(R.id.notifications).isChecked = store.notifications
            v<EditText>(R.id.cf_id2).setText(store.cfClientId)
        }
    }
    private fun error(m: String) { v<TextView>(R.id.error).apply { text = m; visibility = View.VISIBLE }; v<TextView>(R.id.saved).visibility = View.GONE }
    private fun saved(m: String) { v<TextView>(R.id.saved).apply { text = m; visibility = View.VISIBLE }; v<TextView>(R.id.error).visibility = View.GONE }

    private fun signIn() {
        val btn = v<Button>(R.id.sign_in)
        val url = try { OrbApi.cleanUrl(v<EditText>(R.id.url).text.toString()) } catch (e: OrbError) { error(e.message ?: ""); return }
        val pw = v<EditText>(R.id.password).text.toString()
        val name = v<EditText>(R.id.name).text.toString().trim().ifBlank { "Android phone" }
        val cfId = v<EditText>(R.id.cf_id).text.toString().trim()
        val cfSecret = v<EditText>(R.id.cf_secret).text.toString().trim()
        if (cfId.isNotBlank() != (cfSecret.isNotBlank() || store.cfSecret.isNotBlank())) { error("A Cloudflare service token needs both its Client ID and its Client Secret."); return }
        btn.isEnabled = false; btn.text = "Signing in…"
        io.execute {
            try {
                val access = Access(cfId, cfSecret.ifBlank { store.cfSecret }, store.cfCookie)
                val d = OrbApi(url, null, access).signIn(pw, name)
                store.baseUrl = url; store.cfClientId = cfId; if (cfSecret.isNotBlank()) store.cfSecret = cfSecret
                store.token = d.getString("token"); store.deviceId = d.optString("id"); store.deviceName = d.optString("name", name)
                store.alertsSeen = -1; store.lastError = ""
                OrbApp.schedule(this); OrbApp.checkNow(this)
                runOnUiThread { startActivity(Intent(this, MainActivity::class.java)); finish() }
            } catch (e: OrbError) {
                runOnUiThread { error(e.message ?: "Couldn't sign in."); btn.isEnabled = true; btn.text = "Sign in" }
            }
        }
    }

    private fun save() {
        val id = v<EditText>(R.id.cf_id2).text.toString().trim()
        val secret = v<EditText>(R.id.cf_secret2).text.toString().trim()
        if (id.isNotBlank() && secret.isBlank() && store.cfSecret.isBlank()) { error("Add the Client Secret too."); return }
        store.cfClientId = id
        if (id.isBlank()) store.cfSecret = "" else if (secret.isNotBlank()) store.cfSecret = secret
        v<EditText>(R.id.cf_secret2).setText("")
        saved("Saved.")
    }

    private fun signOut() {
        io.execute {
            val err = try { store.api().signOut(store.deviceId); null } catch (e: SignedOut) { null } catch (e: OrbError) { e.message }
            runOnUiThread {
                if (err != null) { error("Couldn't remove this phone on Orb ($err). Try again, or remove it in Orb's Settings → Devices."); return@runOnUiThread }
                store.signOut(); OrbApp.stop(this); Widgets.updateAll(this, null)
                show(); saved("Signed out of this phone.")
            }
        }
    }
    override fun onDestroy() { io.shutdown(); super.onDestroy() }
    companion object { const val MESSAGE = "message" }
}
