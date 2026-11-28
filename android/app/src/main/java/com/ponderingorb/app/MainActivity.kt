package com.ponderingorb.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.Menu
import android.view.MenuItem
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import java.util.concurrent.Executors

/** Orb itself, in a web view: the same page as the browser, signed in with the session this
 *  phone's key buys. Links to other apps open in the browser. */
class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var store: Store
    private val io = Executors.newSingleThreadExecutor()
    private var showingOffline = false

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = Store(this)
        if (!store.signedIn) { startActivity(Intent(this, AccountActivity::class.java)); finish(); return }
        web = WebView(this)
        setContentView(web)
        web.settings.apply {
            javaScriptEnabled = true; domStorageEnabled = true
            // Offline, show what the web view kept from last time rather than an error page.
            cacheMode = if (online()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK
            userAgentString = "$userAgentString PonderingOrbAndroid/1"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        web.webChromeClient = WebChromeClient()
        web.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, req: WebResourceRequest): Boolean {
                val u = req.url.toString()
                if (inside(u)) return false
                try { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(u))) } catch (e: Exception) { }
                return true
            }
            override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) { if (!url.startsWith("data:")) showingOffline = false }
            override fun onPageFinished(view: WebView, url: String) { keepAccessCookie() }
            override fun onReceivedError(view: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) showOffline("Can't reach Orb (${err.description}).")
            }
        }
        if (Build.VERSION.SDK_INT >= 33 && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1)
        }
        OrbApp.schedule(this)
        open(intent.getStringExtra(HASH) ?: "")
    }

    override fun onNewIntent(intent: Intent) { super.onNewIntent(intent); setIntent(intent); open(intent.getStringExtra(HASH) ?: "") }

    private fun inside(u: String): Boolean {
        val o = OrbApi.origin(store.baseUrl)
        return u.startsWith("data:") || (o.isNotBlank() && (u == o || u.startsWith("$o/"))) || Regex("^https://[^/]+\\.cloudflareaccess\\.com/").containsMatchIn(u)
    }
    private fun online(): Boolean {
        val cm = getSystemService(ConnectivityManager::class.java)
        return cm.getNetworkCapabilities(cm.activeNetwork)?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
    }

    /** Buy a fresh session with the key, put it in the web view's cookies, then load Orb. */
    private fun open(hash: String) {
        val url = store.baseUrl + if (hash.isNotBlank()) "/#$hash" else ""
        val headers = store.access().headers().filterKeys { it != "Cookie" }   // the web view sends its own cookies
        io.execute {
            try {
                val s = store.api().session()
                val o = OrbApi.origin(store.baseUrl)
                val secure = if (o.startsWith("https")) "; Secure" else ""
                CookieManager.getInstance().setCookie(o, "orb_session=${s.optString("session")}; Path=/; Max-Age=${s.optLong("maxAge")}; HttpOnly; SameSite=Strict$secure")
                CookieManager.getInstance().flush()
                runOnUiThread { web.loadUrl(url, headers) }
            } catch (e: SignedOut) {
                store.signOut(); OrbApp.stop(this)
                runOnUiThread { startActivity(Intent(this, AccountActivity::class.java).putExtra(AccountActivity.MESSAGE, e.message)); finish() }
            } catch (e: OrbError) {
                // Cloudflare Access wants a sign-in, or we're offline: the web view shows Access's page or its cache.
                runOnUiThread {
                    if (e.message?.contains("Cloudflare Access is asking") == true || !online()) web.loadUrl(url, headers)
                    else showOffline(e.message ?: "Orb didn't answer.")
                }
            }
        }
    }

    /** Remember Cloudflare Access's cookie, so the 15-minute checks and widgets get through too. */
    private fun keepAccessCookie() {
        val all = CookieManager.getInstance().getCookie(OrbApi.origin(store.baseUrl)) ?: return
        all.split(";").map { it.trim() }.firstOrNull { it.startsWith("CF_Authorization=") }?.let { store.cfCookie = it.removePrefix("CF_Authorization=") }
    }

    private fun showOffline(why: String) {
        if (showingOffline) return
        showingOffline = true
        web.loadDataWithBaseURL(null, OfflinePage.html(why, store.glance), "text/html", "utf-8", null)
    }

    override fun onCreateOptionsMenu(menu: Menu): Boolean {
        menu.add(0, 1, 0, "Reload")
        menu.add(0, 2, 0, "Check now")
        menu.add(0, 3, 0, "App settings")
        return true
    }
    override fun onOptionsItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            1 -> { web.settings.cacheMode = if (online()) WebSettings.LOAD_DEFAULT else WebSettings.LOAD_CACHE_ELSE_NETWORK; if (showingOffline) open("") else web.reload() }
            2 -> OrbApp.checkNow(this)
            3 -> startActivity(Intent(this, AccountActivity::class.java))
        }
        return true
    }
    @Deprecated("Activity back handling")
    override fun onBackPressed() { if (::web.isInitialized && web.canGoBack()) web.goBack() else @Suppress("DEPRECATION") super.onBackPressed() }
    override fun onDestroy() { io.shutdown(); super.onDestroy() }

    companion object { const val HASH = "hash" }
}

/** What Orb last showed, when it can't be reached. */
object OfflinePage {
    private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
    fun html(why: String, g: Glance?): String {
        val b = StringBuilder()
        b.append("""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1"><style>
            body{margin:0;padding:20px;background:#0f1119;color:#e9e4d6;font:16px/1.45 sans-serif}h1{font:600 1.3rem serif;color:#e2b553}
            h2{font-size:1rem;color:#e2b553;margin:0 0 6px}.c{background:#161a28;border:1px solid #2d3352;border-radius:12px;padding:12px;margin:10px 0}
            .bad{color:#e8796c}.dim{color:#a39d8c}ul{margin:0;padding-left:18px}</style>""")
        b.append("<h1>Orb is out of reach</h1><p class=dim>${esc(why)} Use ⋮ → Reload to try again. This is what Orb last showed")
        if (g != null) b.append(" (").append(esc(java.text.DateFormat.getDateTimeInstance().format(java.util.Date(g.at)))).append(")")
        b.append(".</p>")
        if (g == null) return b.append("<p class=dim>Nothing saved yet.</p>").toString()
        if (g.upTotal != null) b.append("<div class=c><h2>Services</h2>").append(if (g.down.isEmpty()) "All ${g.upTotal} up" else "<span class=bad>Down: ${esc(g.down.joinToString(", "))}</span>").append("</div>")
        g.brief?.let { b.append("<div class=c><h2>Morning brief</h2>${esc(it)}</div>") }
        if (g.events.isNotEmpty()) b.append("<div class=c><h2>Today</h2><ul>").append(g.events.joinToString("") { "<li><b>${esc(it.time.ifBlank { "all day" })}</b> ${esc(it.title)}</li>" }).append("</ul></div>")
        if (g.tasks.isNotEmpty()) b.append("<div class=c><h2>Tasks</h2><ul>").append(g.tasks.joinToString("") { "<li${if (it.overdue) " class=bad" else ""}>${esc(it.title)}</li>" }).append("</ul></div>")
        if (g.media.isNotEmpty()) b.append("<div class=c><h2>Media</h2><ul>").append(g.media.joinToString("") { "<li><b>${esc(it.name)}</b>: ${esc(it.line)}</li>" }).append("</ul></div>")
        return b.toString()
    }
}
