package org.harborapps.quire.editor

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import org.harborapps.quire.bridge.VaultChanges
import org.harborapps.quire.vault.VaultNode
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * Photos added from the insert sheet: a JPEG in the page's own `images/` folder, linked
 * relative to the page (`images/photo-….jpg`), and marked for sync.
 * Port of PageImages in ios/Quire/Editor/InsertSheet.swift. Call off the main thread.
 */
object PageImages {
    class Failure(message: String = "That photo couldn't be read.") : IOException(message)

    /** Longest side kept; phone photos are 4,000+ px and a page doesn't need that. */
    const val MAX_SIDE = 2048
    private const val JPEG_QUALITY = 82

    @Throws(IOException::class)
    fun save(context: Context, uri: Uri, page: VaultNode): String {
        val bitmap = try {
            decode(context, uri)
        } catch (e: IOException) {
            throw Failure()
        } catch (e: RuntimeException) {
            throw Failure()
        } catch (e: OutOfMemoryError) {
            throw Failure()
        }
        val jpeg = ByteArrayOutputStream().use { out ->
            val flat = flatten(downscaled(bitmap))
            if (!flat.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, out)) throw Failure()
            out.toByteArray()
        }
        val folder = File(page.dir, "images")
        if (!folder.isDirectory && !folder.mkdirs()) throw IOException("Couldn't create ${folder.path}")
        val stamp = SimpleDateFormat("yyyyMMdd-HHmmss", Locale.US).format(Date())
        var name = "photo-$stamp.jpg"
        var n = 2
        while (File(folder, name).exists()) {
            name = "photo-$stamp-$n.jpg"
            n += 1
        }
        writeAtomically(jpeg, File(folder, name))
        VaultChanges.markChanged("${page.path}/images/$name")
        return "images/$name"
    }

    /** Decodes upright (EXIF orientation applied), subsampled to no less than [MAX_SIDE]. */
    private fun decode(context: Context, uri: Uri): Bitmap {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            val source = ImageDecoder.createSource(context.contentResolver, uri)
            return ImageDecoder.decodeBitmap(source) { decoder, info, _ ->
                decoder.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                val side = max(info.size.width, info.size.height)
                decoder.setTargetSampleSize(sampleSize(side))
            }
        }
        val resolver = context.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) } ?: throw Failure()
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw Failure()
        val opts = BitmapFactory.Options().apply { inSampleSize = sampleSize(max(bounds.outWidth, bounds.outHeight)) }
        val raw = resolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, opts) } ?: throw Failure()
        val orientation = try {
            resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: IOException) {
            ExifInterface.ORIENTATION_NORMAL
        }
        return oriented(raw, orientation)
    }

    /** The largest power of two that keeps the longest side at or above [MAX_SIDE]. */
    private fun sampleSize(side: Int): Int {
        var s = 1
        while (side / (s * 2) >= MAX_SIDE) s *= 2
        return s
    }

    private fun oriented(bitmap: Bitmap, orientation: Int): Bitmap {
        val m = Matrix()
        when (orientation) {
            ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> m.setScale(-1f, 1f)
            ExifInterface.ORIENTATION_ROTATE_180 -> m.setRotate(180f)
            ExifInterface.ORIENTATION_FLIP_VERTICAL -> m.setScale(1f, -1f)
            ExifInterface.ORIENTATION_TRANSPOSE -> { m.setRotate(90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_90 -> m.setRotate(90f)
            ExifInterface.ORIENTATION_TRANSVERSE -> { m.setRotate(-90f); m.postScale(-1f, 1f) }
            ExifInterface.ORIENTATION_ROTATE_270 -> m.setRotate(-90f)
            else -> return bitmap
        }
        val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, m, true)
        if (out !== bitmap) bitmap.recycle()
        return out
    }

    /** Same rule as iOS: longest side capped at [MAX_SIDE], dimensions rounded. */
    private fun downscaled(bitmap: Bitmap): Bitmap {
        val side = max(bitmap.width, bitmap.height)
        if (side <= MAX_SIDE) return bitmap
        val scale = MAX_SIDE.toDouble() / side
        val w = (bitmap.width * scale).roundToInt().coerceAtLeast(1)
        val h = (bitmap.height * scale).roundToInt().coerceAtLeast(1)
        val out = Bitmap.createScaledBitmap(bitmap, w, h, true)
        if (out !== bitmap) bitmap.recycle()
        return out
    }

    /** JPEG has no alpha: put transparent images (screenshots, PNGs) on white, not black. */
    private fun flatten(bitmap: Bitmap): Bitmap {
        if (!bitmap.hasAlpha()) return bitmap
        val out = Bitmap.createBitmap(bitmap.width, bitmap.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply {
            drawColor(Color.WHITE)
            drawBitmap(bitmap, 0f, 0f, null)
        }
        bitmap.recycle()
        return out
    }

    /** Temp file next to the target, synced, then renamed (bridge AtomicFile, for bytes). */
    private fun writeAtomically(bytes: ByteArray, file: File) {
        val dir = file.absoluteFile.parentFile ?: throw IOException("No parent for ${file.path}")
        val tmp = File(dir, ".${file.name}.${System.nanoTime()}.tmp")
        try {
            tmp.outputStream().use { out ->
                out.write(bytes)
                out.fd.sync()
            }
            if (!tmp.renameTo(file)) throw IOException("Could not write ${file.path}")
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }
}
