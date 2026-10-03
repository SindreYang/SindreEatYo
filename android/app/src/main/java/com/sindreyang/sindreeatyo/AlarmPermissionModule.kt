package com.sindreyang.sindreeatyo

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import org.json.JSONArray

class AlarmPermissionModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "EatYoAlarm"

  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      val alarmManager = reactContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val notificationManager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val result = com.facebook.react.bridge.Arguments.createMap()
      result.putBoolean("exactAlarm", Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms())
      result.putBoolean("fullScreen", Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || notificationManager.canUseFullScreenIntent())
      result.putBoolean("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || reactContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("STATUS_FAILED", error)
    }
  }

  @ReactMethod
  fun openExactAlarmSettings(promise: Promise) {
    openSettings(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, promise)
  }

  @ReactMethod
  fun openFullScreenSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      openSettings(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, promise)
    } else {
      promise.resolve(null)
    }
  }

  @ReactMethod
  fun openNotificationSettings(promise: Promise) {
    openSettings(Settings.ACTION_APP_NOTIFICATION_SETTINGS, promise)
  }

  @ReactMethod
  fun scheduleAlarms(recordsJson: String, promise: Promise) {
    try {
      val records = JSONArray(recordsJson)
      val preferences = preferences(reactContext)
      AlarmScheduler.cancelAll(reactContext)
      preferences.edit().putString(KEY_RECORDS, records.toString()).apply()
      AlarmScheduler.scheduleRecords(reactContext, records)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SCHEDULE_FAILED", error)
    }
  }

  @ReactMethod
  fun cancelAllAlarms(promise: Promise) {
    try {
      AlarmScheduler.cancelAll(reactContext)
      preferences(reactContext).edit().remove(KEY_RECORDS).apply()
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("CANCEL_FAILED", error)
    }
  }

  @ReactMethod
  fun testAlarm(promise: Promise) {
    try {
      MedicationAlarmReceiver.postNotification(
        reactContext,
        "吃哟咯·测试提醒",
        "如果你听到铃声并感到振动，提醒链路正常。",
        "urgent",
        "test",
        System.currentTimeMillis().toString()
      )
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("TEST_FAILED", error)
    }
  }

  private fun openSettings(action: String, promise: Promise) {
    try {
      val intent = Intent(action).apply { data = Uri.parse("package:${reactContext.packageName}") }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("SETTINGS_FAILED", error)
    }
  }

  companion object {
    const val PREFS_NAME = "eat_yo_alarm"
    const val KEY_RECORDS = "records"

    fun preferences(context: Context): SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
  }
}
