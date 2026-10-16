package com.clubladder.app.auth

import androidx.core.util.AtomicFile
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.Json
import java.io.File
import java.io.FileNotFoundException
import java.io.IOException
import java.security.GeneralSecurityException
import java.security.ProviderException

interface SessionStore {
    fun read(): StoredSession?
    fun write(session: StoredSession)
    fun clear()
}

/**
 * One encrypted file, written atomically. Anything that cannot be decrypted or
 * parsed (a key the Keystore dropped, a file restored onto another phone, a
 * torn write from an older build) is deleted and read as signed out: the
 * member signs in again, rather than the app failing on every launch.
 */
class FileSessionStore(file: File, private val cipher: SessionCipher) : SessionStore {
    private val atomic = AtomicFile(file)
    private val json = Json { ignoreUnknownKeys = true }

    override fun read(): StoredSession? {
        val blob = try {
            atomic.readFully()
        } catch (e: FileNotFoundException) {
            return null
        } catch (e: IOException) {
            return null
        }
        return try {
            json.decodeFromString(StoredSession.serializer(), cipher.decrypt(blob).toString(Charsets.UTF_8))
        } catch (e: GeneralSecurityException) {
            discard()
        } catch (e: ProviderException) {
            discard()
        } catch (e: SerializationException) {
            discard()
        } catch (e: IllegalArgumentException) {
            discard()
        }
    }

    override fun write(session: StoredSession) {
        val blob = cipher.encrypt(json.encodeToString(StoredSession.serializer(), session).toByteArray(Charsets.UTF_8))
        val out = atomic.startWrite()
        try {
            out.write(blob)
            atomic.finishWrite(out)
        } catch (e: IOException) {
            atomic.failWrite(out)
            throw e
        }
    }

    override fun clear() {
        atomic.delete()
    }

    private fun discard(): StoredSession? {
        atomic.delete()
        return null
    }
}
