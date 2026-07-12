package expo.modules.loammeshtransport

/** The decoded presence beacon carried in a BLE advertisement's service data (docs/17). */
internal data class MeshAdvert(
  val version: Int,
  val haveMail: Boolean,
  /** Short opaque group hint (≤ 8 bytes); empty = "any LOAM mesh". Not addressable, not secret. */
  val meshHint: ByteArray,
) {
  fun meshHintHex(): String = meshHint.joinToString("") { "%02x".format(it) }
}

/**
 * (De)serialises [MeshAdvert] into the ~20 usable bytes of a legacy BLE advertisement's service data.
 * Layout: `[magic:1][version:1][flags:1][hintLen:1][hint:hintLen]`. Deliberately tiny — anything
 * bigger than a legacy advert would force extended advertising (Android 8+/BT5), which many peers
 * can't scan for. The sealed payload NEVER travels here; this only says "I'm a LOAM node, and here's
 * whether I'm holding mail."
 */
internal object MeshAdvertCodec {
  private const val MAX_HINT_BYTES = 8

  fun encode(advert: MeshAdvert): ByteArray {
    val hint = if (advert.meshHint.size > MAX_HINT_BYTES) {
      advert.meshHint.copyOf(MAX_HINT_BYTES)
    } else {
      advert.meshHint
    }
    val out = ByteArray(4 + hint.size)
    out[0] = MeshConstants.ADVERT_MAGIC.toByte()
    out[1] = advert.version.toByte()
    out[2] = (if (advert.haveMail) MeshConstants.ADVERT_FLAG_HAVE_MAIL else 0).toByte()
    out[3] = hint.size.toByte()
    hint.copyInto(out, 4)
    return out
  }

  /** Decode service data back into an advert, or null if it isn't a well-formed LOAM beacon. */
  fun decode(data: ByteArray?): MeshAdvert? {
    if (data == null || data.size < 4) {
      return null
    }
    if (data[0].toInt() and 0xFF != MeshConstants.ADVERT_MAGIC) {
      return null
    }
    val version = data[1].toInt() and 0xFF
    val flags = data[2].toInt() and 0xFF
    val hintLen = data[3].toInt() and 0xFF
    if (hintLen > MAX_HINT_BYTES || 4 + hintLen > data.size) {
      return null
    }
    val hint = data.copyOfRange(4, 4 + hintLen)
    return MeshAdvert(
      version = version,
      haveMail = flags and MeshConstants.ADVERT_FLAG_HAVE_MAIL != 0,
      meshHint = hint,
    )
  }

  /** Parse a short base64url/hex-ish JS mesh hint into bytes (best effort; empty on blank). */
  fun hintFromString(value: String?): ByteArray {
    if (value.isNullOrEmpty()) {
      return ByteArray(0)
    }
    return value.toByteArray(Charsets.UTF_8).let {
      if (it.size > MAX_HINT_BYTES) it.copyOf(MAX_HINT_BYTES) else it
    }
  }
}
