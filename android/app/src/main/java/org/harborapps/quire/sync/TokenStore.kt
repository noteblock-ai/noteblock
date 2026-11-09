package org.harborapps.quire.sync

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import org.harborapps.quire.app.QuireApp

/**
 * The GitHub token (iOS: a Keychain generic password). Encrypted with an AES-GCM key that never
 * leaves the AndroidKeyStore; the ciphertext and IV sit in the private prefs file "quire.sync".
 * A restored backup carries the prefs but not the key, so a failed decrypt just forgets it.
 */
object TokenStore {
    private const val ALIAS = "org.harborapps.quire.github"
    private const val KEYSTORE = "AndroidKeyStore"
    private const val TRANSFORM = "AES/GCM/NoPadding"
    private const val PREFS = "quire.sync"
    private const val K_TOKEN = "token"
    private const val K_IV = "iv"

    private val lock = Any()

    private val prefs: SharedPreferences
        get() = QuireApp.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun keyStore(): KeyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? =
        (keyStore().getEntry(ALIAS, null) as? KeyStore.SecretKeyEntry)?.secretKey

    private fun newKey(): SecretKey {
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .build(),
        )
        return gen.generateKey()
    }

    fun token(): String? = synchronized(lock) {
        val p = prefs
        val ct = p.getString(K_TOKEN, null) ?: return null
        val iv = p.getString(K_IV, null)
        try {
            val key = existingKey() ?: throw IllegalStateException("no key")
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(128, Base64.decode(iv ?: throw IllegalStateException("no iv"), Base64.NO_WRAP)))
            String(cipher.doFinal(Base64.decode(ct, Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) {
            deleteLocked()
            null
        }
    }

    fun setToken(t: String) = synchronized(lock) {
        try {
            val key = existingKey() ?: newKey()
            val cipher = Cipher.getInstance(TRANSFORM)
            cipher.init(Cipher.ENCRYPT_MODE, key)
            val ct = cipher.doFinal(t.toByteArray(Charsets.UTF_8))
            val ok = prefs.edit()
                .putString(K_TOKEN, Base64.encodeToString(ct, Base64.NO_WRAP))
                .putString(K_IV, Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
                .commit()
            if (!ok) throw IllegalStateException("prefs write failed")
        } catch (e: Exception) {
            throw SyncException.Message("Couldn't save the token (${e.message ?: e.javaClass.simpleName}).")
        }
    }

    fun deleteToken() = synchronized(lock) { deleteLocked() }

    private fun deleteLocked() {
        prefs.edit().remove(K_TOKEN).remove(K_IV).commit()
        try {
            keyStore().deleteEntry(ALIAS)
        } catch (_: Exception) {
        }
    }
}
