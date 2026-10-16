package com.clubladder.app.auth

class MemorySessionStore(var session: StoredSession? = null) : SessionStore {
    var onWrite: (StoredSession) -> Unit = {}
    var cleared = false

    override fun read(): StoredSession? = session

    override fun write(session: StoredSession) {
        onWrite(session)
        this.session = session
    }

    override fun clear() {
        cleared = true
        session = null
    }
}
