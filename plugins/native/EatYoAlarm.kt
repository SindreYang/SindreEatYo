package com.sindreyang.sindreeatyo

import android.Manifest
import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.app.NotificationCompat
import com.facebook.react.Arguments
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager
import org.json.JSONArray

class AlarmPermissionPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> = listOf(AlarmPermissionModule(reactContext))
  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

class AlarmPermissionModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName(): String = "EatYoAlarm"

  @ReactMethod
  fun getStatus(promise: Promise) {
    try {
      val alarmManager = reactContext.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val notificationManager = reactContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val result = Arguments.createMap()
      result.putBoolean("exactAlarm", Build.VERSION.SDK_INT < Build.VERSION_CODES.S || alarmManager.canScheduleExactAlarms())
      result.putBoolean("fullScreen", Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE || notificationManager.canUseFullScreenIntent())
      result.putBoolean("notifications", Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || reactContext.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED)
      promise.resolve(result)
    } catch (error: Exception) {
      promise.reject("STATUS_FAILED", error)
    }
  }

  @ReactMethod
  fun openExactAlarmSettings(promise: Promise) = openSettings(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, promise)

  @ReactMethod
  fun openFullScreenSettings(promise: Promise) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) openSettings(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, promise) else promise.resolve(null)
  }

  @ReactMethod
  fun openNotificationSettings(promise: Promise) = openSettings(Settings.ACTION_APP_NOTIFICATION_SETTINGS, promise)

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
      MedicationAlarmReceiver.postNotification(reactContext, "吃哟咯·测试提醒", "如果你听到铃声并感到振动，提醒链路正常。", "urgent", "test", System.currentTimeMillis().toString())
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

object AlarmScheduler {
  private const val ACTION_ALARM = "com.sindreyang.sindreeatyo.MEDICATION_ALARM"

  fun scheduleRecords(context: Context, records: JSONArray) {
    cancelAll(context)
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    for (index in 0 until records.length()) {
      val record = records.getJSONObject(index)
      val at = record.optLong("at", 0L)
      if (at <= System.currentTimeMillis()) continue
      val requestCode = requestCode(record.optString("id", index.toString()))
      val broadcastIntent = Intent(context, MedicationAlarmReceiver::class.java).apply {
        action = ACTION_ALARM
        putExtra("title", record.optString("title", "该吃药啦"))
        putExtra("body", record.optString("body", "请进入吃哟咯确认已吃药"))
        putExtra("sound", record.optString("sound", "default"))
        putExtra("itemId", record.optString("itemId", ""))
        putExtra("dueAt", record.optString("dueAt", ""))
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
      val operation = PendingIntent.getBroadcast(context, requestCode, broadcastIntent, flags)
      val showIntent = Intent(context, MainActivity::class.java).apply {
        action = ACTION_ALARM
        putExtra("alarmMode", true)
        putExtra("itemId", record.optString("itemId", ""))
        putExtra("dueAt", record.optString("dueAt", ""))
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      val showPendingIntent = PendingIntent.getActivity(context, requestCode + 1000000, showIntent, flags)
      val alarmInfo = AlarmManager.AlarmClockInfo(at, showPendingIntent)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
        else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) alarmManager.setAlarmClock(alarmInfo, operation)
        else alarmManager.setExact(AlarmManager.RTC_WAKEUP, at, operation)
      } catch (_: SecurityException) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
      }
    }
  }

  fun restore(context: Context) {
    val raw = AlarmPermissionModule.preferences(context).getString(AlarmPermissionModule.KEY_RECORDS, null) ?: return
    try { scheduleRecords(context, JSONArray(raw)) } catch (_: Exception) { }
  }

  fun cancelAll(context: Context) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val raw = AlarmPermissionModule.preferences(context).getString(AlarmPermissionModule.KEY_RECORDS, null) ?: return
    try {
      val records = JSONArray(raw)
      for (index in 0 until records.length()) {
        val record = records.getJSONObject(index)
        val requestCode = requestCode(record.optString("id", index.toString()))
        val intent = Intent(context, MedicationAlarmReceiver::class.java).apply { action = ACTION_ALARM }
        val pending = PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_NO_CREATE or immutableFlag())
        if (pending != null) { alarmManager.cancel(pending); pending.cancel() }
      }
    } catch (_: Exception) { }
  }

  private fun requestCode(value: String): Int = value.hashCode() and 0x7fffffff
  private fun immutableFlag(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
}

class MedicationAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    postNotification(context, intent.getStringExtra("title") ?: "该吃药啦", intent.getStringExtra("body") ?: "请进入吃哟咯确认已吃药", intent.getStringExtra("sound") ?: "default", intent.getStringExtra("itemId") ?: "", intent.getStringExtra("dueAt") ?: System.currentTimeMillis().toString())
  }

  companion object {
    private const val DEFAULT_CHANNEL = "eat-yo-native-default-v2"
    private const val GENTLE_CHANNEL = "eat-yo-native-gentle-v2"
    private const val URGENT_CHANNEL = "eat-yo-native-urgent-v2"

    fun postNotification(context: Context, title: String, body: String, sound: String, itemId: String, dueAt: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      createChannels(context, manager)
      val channel = when (sound) { "gentle" -> GENTLE_CHANNEL; "urgent" -> URGENT_CHANNEL; else -> DEFAULT_CHANNEL }
      val requestCode = ("$itemId-$dueAt".hashCode() and 0x7fffffff)
      val openIntent = Intent(context, MainActivity::class.java).apply {
        action = "com.sindreyang.sindreeatyo.MEDICATION_ALARM"
        putExtra("alarmMode", true)
        putExtra("itemId", itemId)
        putExtra("dueAt", dueAt)
        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
      val contentIntent = PendingIntent.getActivity(context, requestCode, openIntent, flags)
      val builder = NotificationCompat.Builder(context, channel)
        .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
        .setContentTitle(title)
        .setContentText(body)
        .setStyle(NotificationCompat.BigTextStyle().bigText(body))
        .setCategory(NotificationCompat.CATEGORY_ALARM)
        .setPriority(NotificationCompat.PRIORITY_MAX)
        .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
        .setOngoing(true)
        .setAutoCancel(false)
        .setContentIntent(contentIntent)
        .setFullScreenIntent(contentIntent, true)
        .setVibrate(if (sound == "urgent") longArrayOf(0, 450, 120, 450) else longArrayOf(0, 250, 150, 250))
      manager.notify(requestCode, builder.build())
    }

    private fun createChannels(context: Context, manager: NotificationManager) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val alarmAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
      val default = NotificationChannel(DEFAULT_CHANNEL, "吃哟咯·默认提醒", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "吃药时间提醒"; enableVibration(true); vibrationPattern = longArrayOf(0, 250, 150, 250)
        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), alarmAttributes); lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      val gentle = NotificationChannel(GENTLE_CHANNEL, "吃哟咯·轻柔提示", NotificationManager.IMPORTANCE_HIGH).apply {
        enableVibration(true); vibrationPattern = longArrayOf(0, 160)
        setSound(Uri.parse("android.resource://${context.packageName}/${context.resources.getIdentifier("gentle", "raw", context.packageName)}"), alarmAttributes); lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      val urgent = NotificationChannel(URGENT_CHANNEL, "吃哟咯·强提醒", NotificationManager.IMPORTANCE_HIGH).apply {
        enableVibration(true); vibrationPattern = longArrayOf(0, 450, 120, 450)
        setSound(Uri.parse("android.resource://${context.packageName}/${context.resources.getIdentifier("urgent", "raw", context.packageName)}"), alarmAttributes); lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      manager.createNotificationChannels(listOf(default, gentle, urgent))
    }
  }
}

class MedicationBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED || intent.action == "android.intent.action.QUICKBOOT_POWERON" || intent.action == "com.htc.intent.action.QUICKBOOT_POWERON") AlarmScheduler.restore(context)
  }
}
