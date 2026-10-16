package com.clubladder.app.auth

/** Answers each assertion request with the next queued result, and records the request. */
class FakeAuthenticator(vararg results: AssertionResult) : PasskeyAuthenticator {
    private val queue = ArrayDeque(results.toList())
    val requests = mutableListOf<String>()

    override suspend fun getAssertion(requestJson: String): AssertionResult {
        requests.add(requestJson)
        return queue.removeFirst()
    }
}
