package com.ponderingorb.app

import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URI
import java.net.URL
import java.net.URLEncoder

open class OrbError(message: String) : Exception(message)
class SignedOut(message: String) : OrbError(message)

/** Cloudflare Access: a service token (for the background checks and widgets) and/or the
 *  CF_Authorization cookie from signing in to Access in the app's web view. */
data class Access(val clientId: String = "", val clientSecret: String = "", val cookie: String = "") {
    fun headers(): Map<String, String> = buildMap {
        if (clientId.isNotBlank() && clientSecret.isNotBlank()) { put("CF-Access-Client-Id", clientId); put("CF-Access-Client-Secret", clientSecret) }
        if (cookie.isNotBlank()) put("Cookie", "CF_Authorization=$cookie")
    }
}

/** Talks to the Orb server: sign-in, the web view's session, the glance, alerts and small writes.
 *  Blocking: call it off the main thread. */
class OrbApi(val base: String, private val token: String?, private val access: Access = Access()) {

    private fun call(method: String, path: String, body: JSONObject? = null, auth: Boolean = true): String {
        val c = try { URL(base + path).openConnection() as HttpURLConnection } catch (e: Exception) { throw OrbError("\"$base\" isn't an address Orb can use.") }
        try {
            c.requestMethod = method
            c.instanceFollowRedirects = false
            c.connectTimeout = 15000; c.readTimeout = 20000
            c.setRequestProperty("Accept", "application/json")
            access.headers().forEach { (k, v) -> c.setRequestProperty(k, v) }
            if (auth && !token.isNullOrBlank()) c.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) { c.doOutput = true; c.setRequestProperty("Content-Type", "application/json"); c.outputStream.use { it.write(body.toString().toByteArray()) } }
            val code = try { c.responseCode } catch (e: IOException) {
                throw OrbError("Orb isn't answering at $base (${e.javaClass.simpleName}). Check the address, your connection and that the tunnel is up.")
            }
            if (code in 300..399) throw OrbError("Cloudflare Access is asking for a sign-in. Open Orb and sign in there, or add a service token in the app's settings.")
            val text = (if (code < 400) c.inputStream else c.errorStream)?.bufferedReader()?.use { it.readText() } ?: ""
            val json = try { if (text.isBlank()) null else JSONObject(text) } catch (e: Exception) { null }
            if (code == 401 && auth && !token.isNullOrBlank()) throw SignedOut("This phone was signed out of Orb (removed in Settings → Devices, or Orb was reset). Sign in again.")
            if (code == 403 && json == null) throw OrbError("Cloudflare refused the request. Check the service token in the app's settings.")
            if (code >= 400) throw OrbError(json?.optString("error")?.takeIf { it.isNotBlank() } ?: "Orb answered $code.")
            if (json == null && text.isNotBlank()) throw OrbError("That address answered with a web page, not Orb. Check the address.")
            return text
        } finally { c.disconnect() }
    }

    fun signIn(password: String, name: String): JSONObject =
        JSONObject(call("POST", "/api/devices", JSONObject().put("password", password).put("name", name).put("platform", "android"), auth = false))
    /** A session cookie for the web view, bought with this phone's key. */
    fun session(): JSONObject = JSONObject(call("POST", "/api/devices/session"))
    fun glance(): Pair<Glance, String> { val t = call("GET", "/api/glance"); return Glance.parse(t) to t }
    fun alerts(since: Long): Pair<Long, List<Alert>> {
        val o = JSONObject(call("GET", "/api/alerts?since=$since"))
        return o.optLong("now") to o.optJSONArray("alerts").objects().map { Alert.from(it) }
    }
    fun done(taskId: String) { call("POST", "/api/glance/tasks/${URLEncoder.encode(taskId, "UTF-8")}/done", JSONObject()) }
    fun addTask(title: String) { call("POST", "/api/c/tasks", JSONObject().put("title", title).put("done", false)) }
    fun addLog(text: String) { call("POST", "/api/c/logs", JSONObject().put("text", text)) }
    fun signOut(deviceId: String) { call("DELETE", "/api/devices/${URLEncoder.encode(deviceId, "UTF-8")}") }

    companion object {
        /** "orb.example.com" → "https://orb.example.com"; keeps a path, drops the rest. */
        fun cleanUrl(input: String): String {
            var s = input.trim()
            if (s.isEmpty()) throw OrbError("Type Orb's address, like https://orb.thefellashub.com.")
            if (!Regex("^https?://", RegexOption.IGNORE_CASE).containsMatchIn(s)) s = "https://$s"
            val u = try { URI(s) } catch (e: Exception) { throw OrbError("\"$input\" isn't an address. Type it like https://orb.thefellashub.com.") }
            if (u.host.isNullOrBlank()) throw OrbError("\"$input\" isn't an address. Type it like https://orb.thefellashub.com.")
            if (u.userInfo != null) throw OrbError("Leave the user name and password out of the address.")
            val port = if (u.port > 0) ":${u.port}" else ""
            return "${u.scheme.lowercase()}://${u.host}$port${u.path ?: ""}".trimEnd('/')
        }
        fun origin(base: String): String = try { val u = URI(base); "${u.scheme}://${u.host}${if (u.port > 0) ":${u.port}" else ""}" } catch (e: Exception) { "" }
    }
}
