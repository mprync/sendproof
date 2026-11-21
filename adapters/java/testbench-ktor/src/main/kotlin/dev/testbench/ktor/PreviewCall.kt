package dev.testbench.ktor

import dev.testbench.core.CaptureLimits
import dev.testbench.core.CapturedBodies
import dev.testbench.core.CapturedResponse
import dev.testbench.core.PreviewResponseTooLargeException
import com.fasterxml.jackson.databind.JsonNode
import io.ktor.http.Headers
import io.ktor.http.HeadersBuilder
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Parameters
import io.ktor.http.RequestConnectionPoint
import io.ktor.http.content.OutgoingContent
import io.ktor.server.application.Application
import io.ktor.server.application.PipelineCall
import io.ktor.server.engine.BaseApplicationCall
import io.ktor.server.engine.BaseApplicationRequest
import io.ktor.server.engine.BaseApplicationResponse
import io.ktor.server.request.ApplicationRequest
import io.ktor.server.request.RequestCookies
import io.ktor.server.response.ResponseHeaders
import io.ktor.util.AttributeKey
import io.ktor.utils.io.ByteChannel
import io.ktor.utils.io.ByteReadChannel
import io.ktor.utils.io.ByteWriteChannel
import io.ktor.utils.io.InternalAPI
import io.ktor.utils.io.cancel
import io.ktor.utils.io.readAvailable
import java.io.ByteArrayOutputStream
import java.nio.charset.Charset
import java.util.Locale
import kotlin.coroutines.CoroutineContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The original operation's request, replayed in-process. It reuses the real request's method, headers (minus
 * `Accept-Encoding`), cookies, query and body, but reports the rewritten path, so Ktor's own routing and
 * authentication run exactly as for a normal call.
 */
internal class PreviewCall(
    application: Application,
    original: PipelineCall,
    rewrittenUri: String,
    override val coroutineContext: CoroutineContext,
) : BaseApplicationCall(application), CoroutineScope {
    override val request: PreviewRequest = PreviewRequest(this, original.request, rewrittenUri)
    override val response: PreviewResponse = PreviewResponse(this)

    init {
        putResponseAttribute()
    }
}

internal class PreviewRequest(
    call: PreviewCall,
    private val original: ApplicationRequest,
    rewrittenUri: String,
) : BaseApplicationRequest(call) {
    override val local: RequestConnectionPoint = RewrittenPoint(original.local, rewrittenUri)
    override val queryParameters: Parameters get() = original.queryParameters
    override val rawQueryParameters: Parameters get() = original.rawQueryParameters
    override val cookies: RequestCookies = RequestCookies(this)

    // The preview buffers the whole response, so compressed bodies would only be noise.
    override val engineHeaders: Headers = Headers.build {
        original.headers.forEach { name, values ->
            if (!name.equals(HttpHeaders.AcceptEncoding, ignoreCase = true) &&
                !name.equals(HttpHeaders.CacheControl, ignoreCase = true)
            ) {
                appendAll(name, values)
            }
        }
        append(HttpHeaders.CacheControl, "no-cache, no-store")
    }

    override val engineReceiveChannel: ByteReadChannel get() = original.receiveChannel()
}

private class RewrittenPoint(private val point: RequestConnectionPoint, override val uri: String) :
    RequestConnectionPoint by point

/** A buffered response: nothing the handler does here reaches the client until the rollback is confirmed. */
@OptIn(InternalAPI::class)
internal class PreviewResponse(call: PreviewCall) : BaseApplicationResponse(call), CoroutineScope by call {
    private val builder = HeadersBuilder()
    private val body = ByteArrayOutputStream()
    private var collector: Job? = null

    @Volatile
    private var exceeded = false

    override val headers: ResponseHeaders = object : ResponseHeaders() {
        override fun engineAppendHeader(name: String, value: String) {
            builder.append(name, value)
        }

        override fun getEngineHeaderNames(): List<String> = builder.names().toList()

        override fun getEngineHeaderValues(name: String): List<String> = builder.getAll(name).orEmpty()
    }

    override fun setStatus(statusCode: HttpStatusCode) {
        // The base class remembers it; the status is read back through status().
    }

    override suspend fun responseChannel(): ByteWriteChannel {
        val channel = ByteChannel(autoFlush = true)
        collector = launch(Dispatchers.Unconfined) { drain(channel) }
        return channel
    }

    private suspend fun drain(channel: ByteChannel) {
        val buffer = ByteArray(8192)
        while (true) {
            val read = channel.readAvailable(buffer, 0, buffer.size)
            if (read < 0) {
                return
            }
            if (body.size() + read > CaptureLimits.RESPONSE_BYTES) {
                exceeded = true
                channel.cancel(PreviewResponseTooLargeException())
                return
            }
            body.write(buffer, 0, read)
        }
    }

    override suspend fun respondUpgrade(upgrade: OutgoingContent.ProtocolUpgrade) {
        throw UnsupportedOperationException("Test Bench previews cannot upgrade the connection.")
    }

    /** Waits for the buffered body to be fully collected. */
    suspend fun await() {
        collector?.join()
    }

    /** The buffered result in the core's neutral form. Call after [await]. */
    fun captured(): CapturedResponse = object : CapturedResponse {
        override fun status(): Int = this@PreviewResponse.status()?.value ?: HttpStatusCode.OK.value

        override fun headers(): Map<String, List<String>> = builder.build().let { built ->
            built.names().associateWith { built.getAll(it).orEmpty() }
        }

        override fun body(): JsonNode? {
            val type = builder.get(HttpHeaders.ContentType)
            return CapturedBodies.decode(body.toByteArray(), type, type?.let { charsetOf(it) } ?: Charsets.UTF_8)
        }

        override fun exceededLimit(): Boolean = exceeded
    }

    private fun charsetOf(contentType: String): Charset? {
        val token = contentType.lowercase(Locale.ROOT).substringAfter("charset=", "").substringBefore(';').trim('"', ' ')
        return runCatching { Charset.forName(token) }.getOrNull()
    }
}

internal val InnerCallKey: AttributeKey<Boolean> = AttributeKey("TestBench.InnerCall")
