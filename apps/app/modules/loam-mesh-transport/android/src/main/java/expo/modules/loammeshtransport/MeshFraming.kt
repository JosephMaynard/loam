package expo.modules.loammeshtransport

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream

/**
 * Length-prefixed framing for a sealed blob over a stream (a Wi-Fi Aware data-path socket, or the
 * chunked BLE fallback reassembled into a stream). One frame = `[version:1][length:4 BE][bytes]`.
 * Bounded by [MeshConstants.MAX_BLOB_BYTES] so a hostile peer can't announce a huge length and make
 * us allocate. A single socket carries exactly one blob then closes — the courier opens a fresh data
 * path per blob, which keeps the state machine trivial and lets Wi-Fi Aware tear the link down between
 * transfers to save power (docs/16 §5 duty-cycling).
 */
internal object MeshFraming {
  fun writeBlob(output: OutputStream, bytes: ByteArray) {
    if (bytes.size > MeshConstants.MAX_BLOB_BYTES) {
      throw IOException("Blob exceeds the transport cap")
    }
    val out = DataOutputStream(output)
    out.writeByte(MeshConstants.PROTOCOL_VERSION)
    out.writeInt(bytes.size)
    out.write(bytes)
    out.flush()
  }

  fun readBlob(input: InputStream): ByteArray {
    val inp = DataInputStream(input)
    val version = inp.readUnsignedByte()
    if (version != MeshConstants.PROTOCOL_VERSION) {
      throw IOException("Unsupported mesh transport version $version")
    }
    val length = inp.readInt()
    if (length < 0 || length > MeshConstants.MAX_BLOB_BYTES) {
      throw IOException("Blob length out of range: $length")
    }
    val bytes = ByteArray(length)
    inp.readFully(bytes)
    return bytes
  }
}
