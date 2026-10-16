package com.clubladder.app.auth

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.SecureRandom
import javax.crypto.spec.SecretKeySpec

class FileSessionStoreTest {
    @get:Rule
    val folder = TemporaryFolder()

    private fun key() = SecretKeySpec(ByteArray(32).also { SecureRandom().nextBytes(it) }, "AES")

    private val session = StoredSession("access", "refresh", 1_800_000_000L, "user-1", "member@example.invalid")

    @Test
    fun `round trips a session through the cipher`() {
        val k = key()
        val file = File(folder.root, "session.bin")
        FileSessionStore(file, AesGcmSessionCipher { k }).write(session)
        assertFalse(String(file.readBytes()).contains("refresh"))
        assertEquals(session, FileSessionStore(file, AesGcmSessionCipher { k }).read())
    }

    @Test
    fun `reads no file as signed out`() {
        val k = key()
        assertNull(FileSessionStore(File(folder.root, "session.bin"), AesGcmSessionCipher { k }).read())
    }

    @Test
    fun `deletes a corrupted file and reads it as signed out`() {
        val k = key()
        val file = File(folder.root, "session.bin")
        val store = FileSessionStore(file, AesGcmSessionCipher { k })
        store.write(session)
        val bytes = file.readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1].toInt() xor 1).toByte()
        file.writeBytes(bytes)
        assertNull(store.read())
        assertFalse(file.exists())
    }

    @Test
    fun `deletes a file written under another key`() {
        val file = File(folder.root, "session.bin")
        val first = key()
        FileSessionStore(file, AesGcmSessionCipher { first }).write(session)
        val second = key()
        assertNull(FileSessionStore(file, AesGcmSessionCipher { second }).read())
        assertFalse(file.exists())
    }

    @Test
    fun `clears the session`() {
        val k = key()
        val file = File(folder.root, "session.bin")
        val store = FileSessionStore(file, AesGcmSessionCipher { k })
        store.write(session)
        assertTrue(file.exists())
        store.clear()
        assertNull(store.read())
        assertFalse(file.exists())
    }
}
