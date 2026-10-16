package com.clubladder.app.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CancellationException

sealed interface LoadState<out T> {
    data object Loading : LoadState<Nothing>
    data class Error(val message: String) : LoadState<Nothing>
    data class Ready<T>(val data: T) : LoadState<T>
}

class Loader<T>(val state: LoadState<T>, val refreshing: Boolean, val reload: () -> Unit)

/**
 * Runs a loader and keeps its result, its failure and its refresh apart. The
 * loaders throw on a failed read, so an error reaches the screen as an error
 * and never as an empty list. A refresh keeps the last result on screen.
 */
@Composable
fun <T> rememberLoader(key: Any?, load: suspend () -> T): Loader<T> {
    var state by remember(key) { mutableStateOf<LoadState<T>>(LoadState.Loading) }
    var refreshing by remember(key) { mutableStateOf(false) }
    var generation by remember(key) { mutableIntStateOf(0) }

    LaunchedEffect(key, generation) {
        state = try {
            LoadState.Ready(load())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LoadState.Error(e.message ?: "Something went wrong.")
        }
        refreshing = false
    }

    return Loader(state, refreshing) {
        refreshing = true
        generation += 1
    }
}
