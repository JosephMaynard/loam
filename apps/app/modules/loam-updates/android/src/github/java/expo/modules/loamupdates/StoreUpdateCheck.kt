package expo.modules.loamupdates

import android.content.Context

/** GitHub build: there is no store to ask. The app checks GitHub only when someone taps "Check for updates". */
internal object StoreUpdateCheck {
  fun check(@Suppress("UNUSED_PARAMETER") context: Context, done: (Boolean) -> Unit) {
    done(false)
  }
}
