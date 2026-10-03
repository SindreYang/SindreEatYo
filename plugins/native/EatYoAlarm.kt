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
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.provider.Settings
import android.util.Log
import androidx.core.app.NotificationCompat
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Arguments
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
      val powerManager = reactContext.getSystemService(Context.POWER_SERVICE) as PowerManager
      result.putBoolean("batteryOptimizationIgnored", Build.VERSION.SDK_INT < Build.VERSION_CODES.M || powerManager.isIgnoringBatteryOptimizations(reactContext.packageName))
      val prefs = preferences(reactContext)
      result.putString("lastAlarmEvent", prefs.getString(KEY_LAST_EVENT, "") ?: "")
      result.putString("lastAlarmAt", prefs.getString(KEY_LAST_EVENT_AT, "") ?: "")
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
  fun openAppDetailsSettings(promise: Promise) = openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, promise)

  @ReactMethod
  fun openBatteryOptimizationSettings(promise: Promise) {
    try {
      val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
        Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS).apply { data = Uri.parse("package:${reactContext.packageName}") }
      } else {
        Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
      }
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      reactContext.startActivity(intent)
      promise.resolve(null)
    } catch (_: Exception) {
      openSettings(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, promise)
    }
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
      MedicationAlarmReceiver.postNotification(reactContext, "吃哟咯·测试提醒", "如果你听到铃声并感到振动，提醒链路正常。", "default", "test", System.currentTimeMillis().toString())
      android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({ MedicationAlarmReceiver.stopActive(reactContext) }, 10_000L)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("TEST_FAILED", error)
    }
  }

  @ReactMethod
  fun stopAlarm(promise: Promise) {
    try {
      MedicationAlarmReceiver.stopActive(reactContext)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("STOP_FAILED", error)
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
    const val KEY_LAST_EVENT = "last_alarm_event"
    const val KEY_LAST_EVENT_AT = "last_alarm_at"
    fun preferences(context: Context): SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    fun recordEvent(context: Context, event: String) {
      preferences(context).edit().putString(KEY_LAST_EVENT, event).putString(KEY_LAST_EVENT_AT, System.currentTimeMillis().toString()).apply()
      Log.i("EatYoAlarm", event)
    }
  }
}

object AlarmScheduler {
  private const val ACTION_ALARM = "com.sindreyang.sindreeatyo.MEDICATION_ALARM"

  fun scheduleRecords(context: Context, records: JSONArray) {
    cancelAll(context)
    AlarmPermissionModule.recordEvent(context, "schedule_started")
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    var scheduledCount = 0
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
        scheduledCount += 1
      } catch (_: SecurityException) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
        scheduledCount += 1
      }
    }
    AlarmPermissionModule.recordEvent(context, "schedule_count_$scheduledCount")
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
    AlarmPermissionModule.recordEvent(context, "alarm_received")
    postNotification(context, intent.getStringExtra("title") ?: "该吃药啦", intent.getStringExtra("body") ?: "请进入吃哟咯确认已吃药", intent.getStringExtra("sound") ?: "default", intent.getStringExtra("itemId") ?: "", intent.getStringExtra("dueAt") ?: System.currentTimeMillis().toString())
  }

  companion object {
    private const val ALARM_CHANNEL = "eat-yo-native-alarm-v3"
    private var activeRingtone: android.media.Ringtone? = null
    private var activeNotificationId: Int? = null

    fun postNotification(context: Context, title: String, body: String, sound: String, itemId: String, dueAt: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      createChannels(context, manager)
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
      val builder = NotificationCompat.Builder(context, ALARM_CHANNEL)
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
        .setDefaults(NotificationCompat.DEFAULT_ALL)
        .setVibrate(longArrayOf(0, 450, 120, 450))
      manager.notify(requestCode, builder.build())
      activeNotificationId = requestCode
      AlarmPermissionModule.recordEvent(context, "notification_posted")

      val alarmAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
      val alarmUri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM) ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
      if (alarmUri != null) {
        activeRingtone?.stop()
        activeRingtone = RingtoneManager.getRingtone(context, alarmUri)
        activeRingtone?.audioAttributes = alarmAttributes
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) activeRingtone?.isLooping = true
        activeRingtone?.play()
        AlarmPermissionModule.recordEvent(context, "ringtone_started")
      }

      val vibrator = context.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      if (vibrator.hasVibrator()) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 450, 120, 450), -1))
        else {
          @Suppress("DEPRECATION")
          vibrator.vibrate(longArrayOf(0, 450, 120, 450), -1)
        }
        AlarmPermissionModule.recordEvent(context, "vibration_started")
      }
    }

    fun stopActive(context: Context) {
      activeRingtone?.stop()
      activeRingtone = null
      activeNotificationId?.let { (context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(it) }
      activeNotificationId = null
      AlarmPermissionModule.recordEvent(context, "alarm_stopped")
    }

    private fun createChannels(context: Context, manager: NotificationManager) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val alarmAttributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
      val alarm = NotificationChannel(ALARM_CHANNEL, "吃哟咯·闹钟提醒", NotificationManager.IMPORTANCE_HIGH).apply {
        description = "吃药时间提醒，使用手机系统闹钟铃声"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 450, 120, 450)
        // Sound and vibration are also started directly below. Keeping the channel
        // silent avoids duplicate audio while still allowing heads-up/full-screen UI.
        setSound(null, alarmAttributes)
        lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      manager.createNotificationChannel(alarm)
    }
  }
}

class MedicationBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED || intent.action == "android.intent.action.QUICKBOOT_POWERON" || intent.action == "com.htc.intent.action.QUICKBOOT_POWERON") AlarmScheduler.restore(context)
  }
}
