package com.clubladder.app.auth

import android.content.Context
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.exceptions.GetCredentialInterruptedException
import androidx.credentials.exceptions.GetCredentialProviderConfigurationException
import androidx.credentials.exceptions.GetCredentialUnsupportedException
import androidx.credentials.exceptions.NoCredentialException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException

/**
 * Credential Manager, which on API 33 and below goes through Play services
 * (credentials-play-services-auth) and on 34 and up through the platform.
 * [activityContext] must be an Activity: the account sheet is shown over it.
 * The manager is made on first use, so a member who never taps the passkey
 * button never loads it.
 *
 * Only a real cancel is silent. A DOM NotAllowedError is NOT treated as one:
 * a broken assetlinks file or an RP ID mismatch surfaces as exactly that, and
 * reading it as a cancel would make a misconfigured server look like a member
 * who changed their mind (the website's passkey client learned the same).
 * Nothing here is logged: the request and the response are both sensitive.
 */
class CredentialManagerAuthenticator(private val activityContext: Context) : PasskeyAuthenticator {
    private val manager by lazy { CredentialManager.create(activityContext) }

    override suspend fun getAssertion(requestJson: String): AssertionResult {
        val request = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(requestJson)))
        // Only GetCredentialException is caught: a coroutine cancelled with its
        // screen must stay cancelled, not become a sign-in failure.
        return try {
            val credential = manager.getCredential(activityContext, request).credential
            if (credential is PublicKeyCredential) {
                AssertionResult.Ok(credential.authenticationResponseJson)
            } else {
                AssertionResult.Failed("unexpected_type")
            }
        } catch (e: GetCredentialCancellationException) {
            AssertionResult.Cancelled
        } catch (e: NoCredentialException) {
            AssertionResult.NoCredential
        } catch (e: GetCredentialProviderConfigurationException) {
            AssertionResult.Unavailable
        } catch (e: GetCredentialUnsupportedException) {
            AssertionResult.Unavailable
        } catch (e: GetCredentialInterruptedException) {
            AssertionResult.Failed("interrupted")
        } catch (e: GetPublicKeyCredentialDomException) {
            AssertionResult.Failed(e.domError.type)
        } catch (e: GetCredentialException) {
            AssertionResult.Failed(e.type)
        }
    }
}
