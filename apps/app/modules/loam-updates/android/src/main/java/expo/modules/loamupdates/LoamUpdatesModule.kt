package expo.modules.loamupdates

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * Tells the host app which store this build came from, and (Play build only) whether Google Play has a
 * newer version. The Play check asks the Play Store app on the phone; LOAM itself contacts no server.
 * The GitHub build's `StoreUpdateCheck` is a stub, so it never touches Play.
 */
class LoamUpdatesModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("LoamUpdates")

    /** `"play"` or `"github"`, fixed at build time (android/build.gradle, -PloamDistribution). */
    Function("distribution") {
      BuildConfig.LOAM_DISTRIBUTION
    }

    /** `{ available }` from the store this build came from. Never rejects: any failure is "no update". */
    AsyncFunction("checkStoreUpdate") { promise: Promise ->
      val context = appContext.reactContext?.applicationContext
      if (context == null) {
        promise.resolve(mapOf("available" to false))
        return@AsyncFunction
      }
      StoreUpdateCheck.check(context) { available -> promise.resolve(mapOf("available" to available)) }
    }
  }
}
