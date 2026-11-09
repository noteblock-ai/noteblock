package org.harborapps.quire.bridge

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import java.math.BigDecimal
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * JSON the way the page's JavaScript writes and reads it (JSON.stringify / JSON.parse):
 * fragments allowed, no escaped slashes, numbers printed like JS (1.0 → 1), NaN/Infinity as
 * null, dates as ISO strings. Port of the JSONValue enum in ios/Quire/Bridge/PageStore.swift.
 */
object JsonValue {
    private val json = Json { isLenient = false }

    /** JSON.parse: any JSON text, including fragments ("1", "\"x\"", "null"). Throws on bad JSON. */
    fun parse(s: String): JsonElement = json.parseToJsonElement(s)

    /** JSON.stringify of a sanitized value. `null` → "null". */
    fun stringify(value: Any?): String = json.encodeToString(JsonElement.serializer(), sanitize(value))

    /**
     * A JsonElement as JSON.stringify would see the value: numbers normalised to JS form
     * (NaN / Infinity → null), Kotlin values (String, Number, Boolean, Date, Map, List, null)
     * converted, anything else → null.
     */
    fun sanitize(value: Any?): JsonElement = when (value) {
        null, JsonNull -> JsonNull
        is JsonObject -> JsonObject(value.mapValues { sanitize(it.value) })
        is JsonArray -> JsonArray(value.map { sanitize(it) })
        is JsonPrimitive -> when {
            value.isString -> value
            value.booleanOrNull != null -> value
            else -> numberLiteral(value.content)
        }
        is String -> JsonPrimitive(value)
        is Boolean -> JsonPrimitive(value)
        is Int, is Long, is Short, is Byte -> JsonPrimitive((value as Number).toLong())
        is Number -> {
            val d = value.toDouble()
            if (d.isNaN() || d.isInfinite()) JsonNull else JsonUnquoted(jsNumber(d))
        }
        is Date -> JsonPrimitive(isoString(value))
        is Map<*, *> -> JsonObject(value.entries.associate { (k, v) -> k.toString() to sanitize(v) })
        is Iterable<*> -> JsonArray(value.map { sanitize(it) })
        is Array<*> -> JsonArray(value.map { sanitize(it) })
        else -> JsonNull
    }

    /** String(v) in JavaScript: strings as they are, numbers without ".0", true/false, "null". */
    fun jsString(v: Any?): String = when (v) {
        null, JsonNull -> "null"
        is JsonPrimitive -> when {
            v.isString -> v.content
            v.booleanOrNull != null -> v.content
            else -> v.content.toDoubleOrNull()?.let { jsNumberLiteral(v.content, it) } ?: v.content
        }
        is JsonArray -> v.joinToString(",") { if (it is JsonNull) "" else jsString(it) }
        is JsonObject -> "[object Object]"
        is String -> v
        is Boolean -> v.toString()
        is Int, is Long, is Short, is Byte -> v.toString()
        is Number -> jsNumber(v.toDouble())
        else -> v.toString()
    }

    /** Number.prototype.toString for a double: 1.0 → "1", 1e21 → "1e+21", 1e-7 → "1e-7". */
    fun jsNumber(d: Double): String {
        if (d.isNaN()) return "NaN"
        if (d.isInfinite()) return if (d > 0) "Infinity" else "-Infinity"
        if (d == 0.0) return "0"
        val abs = kotlin.math.abs(d)
        if (abs >= 1e-6 && abs < 1e21) {
            // Double.toString is the shortest round-trip repr; expand any exponent.
            return BigDecimal(d.toString()).stripTrailingZeros().toPlainString()
        }
        // Exponent form: "1.5E-7" → "1.5e-7", "1.0E21" → "1e+21".
        val s = d.toString()
        val i = s.indexOf('E')
        if (i < 0) return s
        var mant = s.substring(0, i)
        if (mant.endsWith(".0")) mant = mant.dropLast(2)
        val exp = s.substring(i + 1)
        return mant + "e" + (if (exp.startsWith("-")) exp else "+$exp")
    }

    /** A JSON number literal as JS would re-print it; integers that fit a Long stay exact. */
    private fun numberLiteral(content: String): JsonElement {
        content.toLongOrNull()?.let { return JsonPrimitive(it) }
        val d = content.toDoubleOrNull() ?: return JsonNull
        if (d.isNaN() || d.isInfinite()) return JsonNull
        return JsonUnquoted(jsNumber(d))
    }

    private fun jsNumberLiteral(content: String, d: Double): String =
        content.toLongOrNull()?.toString() ?: jsNumber(d)

    /** A raw (unquoted) number primitive whose content is printed verbatim. */
    @Suppress("FunctionName")
    private fun JsonUnquoted(content: String): JsonPrimitive {
        content.toLongOrNull()?.let { return JsonPrimitive(it) }
        return json.parseToJsonElement(content) as JsonPrimitive
    }

    /** Date.prototype.toISOString: 2026-10-23T12:34:56.789Z. */
    private fun isoString(d: Date): String =
        SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply {
            timeZone = TimeZone.getTimeZone("UTC")
        }.format(d)
}
