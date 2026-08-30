package com.hiennv.flutter_callkit_incoming

import android.content.Context
import android.content.Intent
import android.content.res.Resources
import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.ObjectMapper
import java.lang.ref.WeakReference


class Utils {

    companion object {

        private var mapper: ObjectMapper? = null


        fun getGsonInstance(): ObjectMapper {
            if (mapper == null) {
                // Comm patch: this ObjectMapper (despite its Gson-flavored name) is what
                // SharedPreferencesUtils.kt's addCall/removeCall use to persist the
                // "ACTIVE_CALLS" list — the plugin's own source of truth for whether a
                // given call id is currently tracked at all. Found live: a call's own
                // JSON payload (Data's `args` map) can legitimately carry a `muted` key
                // Jackson's default strict bean deserialization doesn't recognize as a
                // property on `Data` (54 known properties, not this one) — Jackson's
                // default is to THROW on any such unknown field, which meant addCall()
                // silently failed on every single incoming call, the call was NEVER
                // actually added to ACTIVE_CALLS, and endCall() (this app's own call-end
                // push handler) could never find it afterward — `currentCall` came back
                // null, so its whole teardown branch (Telecom disconnect, notification
                // clear, foreground-service stop, and the Activity-closing broadcast that
                // releases its screen-wake lock) silently no-op'd. This is the actual root
                // cause behind the screen staying lit / stuck "ongoing call" notification
                // reports — not the wake-lock timeout itself, which was a real but
                // secondary bug. Ignoring unknown properties is the standard, robust
                // Jackson fix for exactly this class of forward/backward-compatibility
                // mismatch, rather than chasing down every field that might appear.
                mapper = ObjectMapper()
                    .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
            }
            return mapper!!
        }

        @JvmStatic
        fun dpToPx(dp: Float): Float {
            return dp * Resources.getSystem().displayMetrics.density
        }

        @JvmStatic
        fun pxToDp(px: Float): Float {
            return px / Resources.getSystem().displayMetrics.density
        }

        @JvmStatic
        fun getScreenWidth(): Int {
            return Resources.getSystem().displayMetrics.widthPixels
        }

        @JvmStatic
        fun getScreenHeight(): Int {
            return Resources.getSystem().displayMetrics.heightPixels
        }

        fun getNavigationBarHeight(context: Context): Int {
            val resources = context.resources
            val id = resources.getIdentifier(
                    "navigation_bar_height", "dimen", "android"
            )
            return if (id > 0) {
                resources.getDimensionPixelSize(id)
            } else 0
        }

        fun getStatusBarHeight(context: Context): Int {
            val resources = context.resources
            val id: Int =
                    resources.getIdentifier("status_bar_height", "dimen", "android")
            return if (id > 0) {
                resources.getDimensionPixelSize(id)
            } else 0
        }

        fun backToForeground(context: Context) {
            val packageName = context.packageName
            val intent = context.packageManager.getLaunchIntentForPackage(packageName)?.cloneFilter()
            intent?.addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT)
            intent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            intent?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK)
            context.startActivity(intent)
        }

        fun <T, C : MutableCollection<WeakReference<T>>> C.reapCollection(): C {
            this.removeAll {
                it.get() == null
            }
            return this
        }

        fun isTablet(context: Context): Boolean {
            return context.resources.getBoolean(R.bool.isTablet)
        }
    }
}
