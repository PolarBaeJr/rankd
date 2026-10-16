package com.clubladder.app.auth

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

/**
 * The session key lives in the Android Keystore and never leaves it. No user
 * authentication is required on it: the app must refresh a token in the
 * background of an ordinary launch, not ask for a fingerprint each time.
 * EncryptedSharedPreferences is not used; androidx.security-crypto is deprecated.
 */
class KeystoreSessionCipher : AesGcmSessionCipher(::loadOrCreateKey)

private const val KEYSTORE = "AndroidKeyStore"
private const val KEY_ALIAS = "badminton_session_v1"

private fun loadOrCreateKey(): SecretKey {
    val keyStore = KeyStore.getInstance(KEYSTORE).apply { load(null) }
    (keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(
        KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build(),
    )
    return generator.generateKey()
}
