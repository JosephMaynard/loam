package expo.modules.loamupdates

import android.content.Context
import android.util.Log
import com.google.android.play.core.appupdate.AppUpdateManagerFactory
import com.google.android.play.core.install.model.UpdateAvailability

/**
 * Play build: asks the Play Store app on this phone whether Google Play has a newer LOAM. Offline, or
 * when LOAM wasn't installed from Play, the answer is simply "no update".
 */
internal object StoreUpdateCheck {
  fun check(context: Context, done: (Boolean) -> Unit) {
    try {
      AppUpdateManagerFactory.create(context).appUpdateInfo
        .addOnSuccessListener { info -> done(info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE) }
        .addOnFailureListener { error ->
          Log.i("LoamUpdates", "Play update check failed: ${error.message}")
          done(false)
        }
    } catch (error: Exception) {
      Log.i("LoamUpdates", "Play update check unavailable: ${error.message}")
      done(false)
    }
  }
}
