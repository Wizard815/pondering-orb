package com.ponderingorb.app

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

const val SAMPLE = """{"at":1764280000000,"day":"2026-11-27","uptime":{"total":14,"down":["Plex","Sonarr"]},
 "events":[{"time":"09:30","title":"Dentist","calendar":"Family"},{"time":"","title":"Bin day"}],
 "tasks":[{"id":"t1","title":"Renew the domain","due":"2026-11-20","overdue":true},{"id":"t2","title":"Patch Unraid","due":"","overdue":false}],
 "chores":[{"id":"c1","name":"Water plants","due":"2026-11-27"}],"brief":{"day":"2026-11-27","headline":"Good morning! Rain by noon."},
 "media":[{"name":"Plex","type":"plex","line":"Playing: Dune (Robin)"},{"name":"Seerr","type":"seerr","line":"2 requests waiting"}],"alerts":3,"errors":[]}"""

class GlanceTest {
    @Test fun parsesTheGlance() {
        val g = Glance.parse(SAMPLE)
        assertEquals(14, g.upTotal)
        assertEquals(listOf("Plex", "Sonarr"), g.down)
        assertEquals("2 services down", g.statusLine)
        assertEquals("Dentist", g.events[0].title)
        assertTrue(g.tasks[0].overdue)
        assertEquals(listOf("Water plants"), g.chores)
        assertEquals("Good morning! Rain by noon.", g.brief)
        assertEquals("Seerr", g.media[1].name)
    }

    @Test fun statusLineAndMissingParts() {
        val g = Glance.parse("""{"at":1,"day":"d","uptime":null,"events":[],"tasks":[],"chores":[],"brief":null,"media":[],"alerts":0}""")
        assertNull(g.upTotal); assertNull(g.brief)
        assertEquals("Orb", g.statusLine)
        assertEquals("All 3 up", g.copy(upTotal = 3).statusLine)
        assertEquals("Plex is down", g.copy(upTotal = 3, down = listOf("Plex")).statusLine)
    }

    @Test fun notifiesOnlyTheLastFew() {
        val a = (1..5).map { Alert("$it", it.toLong(), "uptime", "t$it", "", 3) }
        val (show, more) = toNotify(a)
        assertEquals(listOf("t3", "t4", "t5"), show.map { it.title }); assertEquals(2, more)
    }

    @Test fun tickingOffRemovesTheTaskFromTheCache() {
        val left = Glance.parse(withoutTask(SAMPLE, "t1")).tasks
        assertEquals(listOf("t2"), left.map { it.id })
        assertEquals("not json", withoutTask("not json", "t1"))
    }

    @Test fun offlinePageEscapes() {
        val g = Glance.parse(SAMPLE).copy(tasks = listOf(Glance.Task("x", "<script>alert(1)</script>", "", false)))
        val html = OfflinePage.html("Can't reach <Orb>.", g)
        assertFalse(html.contains("<script>alert"))
        assertTrue(html.contains("&lt;script&gt;"))
        assertTrue(html.contains("Down: Plex, Sonarr"))
    }

    @Test fun cleansAddresses() {
        assertEquals("https://orb.thefellashub.com", OrbApi.cleanUrl("orb.thefellashub.com"))
        assertEquals("http://192.168.20.5:8095", OrbApi.cleanUrl(" http://192.168.20.5:8095/ "))
        assertEquals("https://example.com/orb", OrbApi.cleanUrl("https://example.com/orb/?x=1"))
        assertEquals("http://192.168.20.5:8095", OrbApi.origin("http://192.168.20.5:8095/orb"))
        for (bad in listOf("", "https://me:pw@orb.example.com")) try { OrbApi.cleanUrl(bad); fail(bad) } catch (e: OrbError) { }
    }

    @Test fun accessHeaders() {
        assertEquals(emptyMap<String, String>(), Access().headers())
        assertEquals(mapOf("CF-Access-Client-Id" to "id", "CF-Access-Client-Secret" to "s"), Access("id", "s").headers())
        assertEquals(emptyMap<String, String>(), Access("id", "").headers())
        assertEquals(mapOf("Cookie" to "CF_Authorization=jwt"), Access(cookie = "jwt").headers())
    }

    /** A tiny HTTP server on a socket (the JDK's HttpServer isn't on Android's test classpath). */
    private fun serve(h: (method: String, path: String, headers: Map<String, String>) -> Triple<Int, Map<String, String>, String>): Pair<String, java.net.ServerSocket> {
        val ss = java.net.ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))
        Thread {
            while (!ss.isClosed) {
                val sock = try { ss.accept() } catch (e: Exception) { break }
                sock.use { so ->
                    val r = so.getInputStream().bufferedReader()
                    val (method, path) = r.readLine().split(" ").let { it[0] to it[1] }
                    val hs = mutableMapOf<String, String>()
                    while (true) { val l = r.readLine() ?: break; if (l.isEmpty()) break; val i = l.indexOf(':'); hs[l.substring(0, i).lowercase()] = l.substring(i + 1).trim() }
                    val len = hs["content-length"]?.toInt() ?: 0
                    if (len > 0) { val buf = CharArray(len); var n = 0; while (n < len) n += r.read(buf, n, len - n) }
                    val (code, extra, body) = h(method, path, hs)
                    val b = body.toByteArray()
                    val head = StringBuilder("HTTP/1.1 $code X\r\nContent-Length: ${b.size}\r\nConnection: close\r\n")
                    extra.forEach { (k, v) -> head.append("$k: $v\r\n") }
                    so.getOutputStream().apply { write(head.append("\r\n").toString().toByteArray()); write(b); flush() }
                }
            }
        }.apply { isDaemon = true }.start()
        return "http://127.0.0.1:${ss.localPort}" to ss
    }

    @Test fun clientSendsTheKeyAndSaysWhatWentWrong() {
        val seen = mutableListOf<String>()
        val json = mapOf("Content-Type" to "application/json")
        val (base, ss) = serve { _, path, h ->
            when {
                path == "/api/glance" -> { seen += "${h["authorization"]}|${h["cf-access-client-id"]}"; if (h["authorization"] == "Bearer orbd_good") Triple(200, json, SAMPLE) else Triple(401, json, """{"error":"Sign in first"}""") }
                path == "/api/devices" -> Triple(401, json, """{"error":"That password isn't right."}""")
                path == "/page" -> Triple(200, mapOf("Content-Type" to "text/html"), "<html>hi</html>")
                path == "/cf" -> Triple(302, mapOf("Location" to "https://team.cloudflareaccess.com/login"), "")
                else -> Triple(404, json, "{}")
            }
        }
        try {
            assertEquals(14, OrbApi(base, "orbd_good", Access("cid", "sec")).glance().first.upTotal)
            assertEquals("Bearer orbd_good|cid", seen[0])
            try { OrbApi(base, "orbd_removed").glance(); fail() } catch (e: SignedOut) { }
            try { OrbApi(base, null).signIn("wrong", "Phone"); fail() } catch (e: OrbError) { assertEquals("That password isn't right.", e.message) }
            val call = OrbApi::class.java.getDeclaredMethod("call", String::class.java, String::class.java, JSONObject::class.java, Boolean::class.javaPrimitiveType).apply { isAccessible = true }
            fun msg(path: String) = try { call.invoke(OrbApi(base, "k"), "GET", path, null, true); "" } catch (e: java.lang.reflect.InvocationTargetException) { e.targetException.message ?: "" }
            assertTrue(msg("/page"), msg("/page").contains("web page, not Orb"))
            assertTrue(msg("/cf").contains("Cloudflare Access is asking"))
            try { OrbApi("http://127.0.0.1:9", "k").glance(); fail() } catch (e: OrbError) { assertTrue(e.message!!.contains("isn't answering")) }
        } finally { ss.close() }
    }
}
