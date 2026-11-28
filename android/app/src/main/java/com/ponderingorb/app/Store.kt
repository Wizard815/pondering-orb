package com.ponderingorb.app

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** What the app keeps: Orb's address, this phone's key and the Cloudflare secret (both encrypted
 *  with a key in the Android Keystore, which never leaves the phone), and the last glance for the
 *  widgets and the offline view. Never Orb's password. */
class Store(context: Context) {
    private val prefs = context.getSharedPreferences("orb", Context.MODE_PRIVATE)

    var baseUrl: String
        get() = prefs.getString("base_url", "") ?: ""
        set(v) = prefs.edit().putString("base_url", v.trim().trimEnd('/')).apply()
    var deviceId: String
        get() = prefs.getString("device_id", "") ?: ""
        set(v) = prefs.edit().putString("device_id", v).apply()
    var deviceName: String
        get() = prefs.getString("device_name", "") ?: ""
        set(v) = prefs.edit().putString("device_name", v).apply()
    var cfClientId: String
        get() = prefs.getString("cf_client_id", "") ?: ""
        set(v) = prefs.edit().putString("cf_client_id", v.trim()).apply()
    /** The CF_Authorization cookie from signing in to Access in the web view, for background checks. */
    var cfCookie: String
        get() = prefs.getString("cf_cookie", "") ?: ""
        set(v) = prefs.edit().putString("cf_cookie", v).apply()
    var notifications: Boolean
        get() = prefs.getBoolean("notifications", true)
        set(v) = prefs.edit().putBoolean("notifications", v).apply()
    /** The newest alert this phone has shown; -1 until the first check. */
    var alertsSeen: Long
        get() = prefs.getLong("alerts_seen", -1)
        set(v) = prefs.edit().putLong("alerts_seen", v).apply()
    var glanceJson: String
        get() = prefs.getString("glance", "") ?: ""
        set(v) = prefs.edit().putString("glance", v).apply()
    var lastError: String
        get() = prefs.getString("last_error", "") ?: ""
        set(v) = prefs.edit().putString("last_error", v).apply()

    val glance: Glance? get() = glanceJson.takeIf { it.isNotBlank() }?.let { try { Glance.parse(it) } catch (e: Exception) { null } }

    var token: String?
        get() = prefs.getString("token", null)?.let { decrypt(it) }
        set(v) = prefs.edit().putString("token", v?.let { encrypt(it) }).apply()
    var cfSecret: String
        get() = prefs.getString("cf_secret", null)?.let { decrypt(it) } ?: ""
        set(v) = prefs.edit().putString("cf_secret", v.takeIf { it.isNotBlank() }?.let { encrypt(it.trim()) }).apply()

    val signedIn get() = baseUrl.isNotBlank() && token != null
    fun access() = Access(cfClientId, cfSecret, cfCookie)
    fun api() = OrbApi(baseUrl, token, access())

    /** Signing out keeps the address and the Cloudflare token (they belong to the server, not the sign-in). */
    fun signOut() { prefs.edit().remove("token").remove("device_id").remove("alerts_seen").remove("glance").remove("last_error").apply() }

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return gen.generateKey()
    }
    private fun encrypt(plain: String): String {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
        return Base64.encodeToString(c.iv + c.doFinal(plain.toByteArray()), Base64.NO_WRAP)
    }
    private fun decrypt(stored: String): String? = try {
        val b = Base64.decode(stored, Base64.NO_WRAP)
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, b, 0, 12)) }
        String(c.doFinal(b, 12, b.size - 12))
    } catch (e: Exception) { null }   // the key is gone (restored to another phone): sign in again

    companion object { private const val ALIAS = "orb-device-key" }
}
