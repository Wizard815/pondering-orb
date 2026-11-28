package com.ponderingorb.app

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import android.widget.Toast
import java.util.concurrent.Executors

/** Share → Orb from any app (a link, some text), or the "Add a task" shortcut:
 *  it becomes a task or a log entry. */
class ShareActivity : Activity() {
    private val io = Executors.newSingleThreadExecutor()
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = Store(this)
        if (!store.signedIn) { startActivity(Intent(this, AccountActivity::class.java)); finish(); return }
        setContentView(R.layout.activity_share)
        val text = findViewById<EditText>(R.id.text)
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty()
        val shared = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty()
        text.setText(listOf(subject, shared).filter { it.isNotBlank() }.distinct().joinToString(" ").take(500))
        val err = findViewById<TextView>(R.id.error)
        fun send(what: String, f: (OrbApi, String) -> Unit) {
            val t = text.text.toString().trim()
            if (t.isEmpty()) { err.text = "Type something first."; return }
            io.execute {
                try { f(store.api(), t); runOnUiThread { Toast.makeText(this, "Added to Orb as a $what.", Toast.LENGTH_SHORT).show(); OrbApp.checkNow(this); finish() } }
                catch (e: OrbError) { runOnUiThread { err.text = e.message } }
            }
        }
        findViewById<Button>(R.id.as_task).setOnClickListener { send("task") { api, t -> api.addTask(t) } }
        findViewById<Button>(R.id.as_log).setOnClickListener { send("log entry") { api, t -> api.addLog(t) } }
        findViewById<Button>(R.id.cancel).setOnClickListener { finish() }
    }
    override fun onDestroy() { io.shutdown(); super.onDestroy() }
}
