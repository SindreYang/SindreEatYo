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
import org.json.JSONObject
import java.text.SimpleDateFormat
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

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
      result.putString("recentAlarmEvents", prefs.getString(KEY_EVENT_HISTORY, "[]") ?: "[]")
      result.putBoolean("backgroundServiceEnabled", prefs.getBoolean(KEY_BACKGROUND_SERVICE, true))
      result.putBoolean("backgroundServiceRunning", AlarmForegroundService.isRunning())
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
      AlarmForegroundService.startAlarm(reactContext, "吃哟咯·测试提醒", "如果你听到铃声并感到振动，提醒链路正常。", "test", System.currentTimeMillis().toString(), true)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("TEST_FAILED", error)
    }
  }

  @ReactMethod
  fun stopAlarm(itemId: String?, dueAt: String?, promise: Promise) {
    try {
      AlarmForegroundService.stopActive(reactContext, itemId, dueAt)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("STOP_FAILED", error)
    }
  }

  @ReactMethod
  fun startBackgroundService(promise: Promise) {
    try {
      preferences(reactContext).edit().putBoolean(KEY_BACKGROUND_SERVICE, true).apply()
      AlarmForegroundService.startBackground(reactContext)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("BACKGROUND_START_FAILED", error)
    }
  }

  @ReactMethod
  fun stopBackgroundService(promise: Promise) {
    try {
      AlarmForegroundService.stopBackground(reactContext)
      promise.resolve(null)
    } catch (error: Exception) {
      promise.reject("BACKGROUND_STOP_FAILED", error)
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
    const val KEY_BACKGROUND_SERVICE = "background_service_enabled"
    const val KEY_EVENT_HISTORY = "alarm_event_history"
    fun preferences(context: Context): SharedPreferences = context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
    fun recordEvent(context: Context, event: String) {
      val prefs = preferences(context)
      val now = System.currentTimeMillis()
      val history = try { JSONArray(prefs.getString(KEY_EVENT_HISTORY, "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
      history.put(JSONObject().put("at", now).put("event", event))
      while (history.length() > 80) history.remove(0)
      prefs.edit().putString(KEY_LAST_EVENT, event).putString(KEY_LAST_EVENT_AT, now.toString()).putString(KEY_EVENT_HISTORY, history.toString()).apply()
      Log.i("EatYoAlarm", event)
    }
  }
}

object AlarmScheduler {
  private const val ACTION_ALARM = "com.sindreyang.sindreeatyo.MEDICATION_ALARM"

  fun scheduleRecords(context: Context, records: JSONArray) {
    cancelAll(context)
    AlarmPermissionModule.recordEvent(context, "schedule_started")
    val stored = JSONArray()
    var scheduledCount = 0
    for (index in 0 until records.length()) {
      val record = records.getJSONObject(index)
      if (scheduleRecord(context, record)) {
        stored.put(record)
        scheduledCount += 1
      }
    }
    AlarmPermissionModule.preferences(context).edit().putString(AlarmPermissionModule.KEY_RECORDS, stored.toString()).apply()
    AlarmPermissionModule.recordEvent(context, "schedule_count_$scheduledCount")
    if (scheduledCount > 0 && AlarmPermissionModule.preferences(context).getBoolean(AlarmPermissionModule.KEY_BACKGROUND_SERVICE, true)) {
      AlarmForegroundService.startBackground(context)
    } else if (scheduledCount == 0) {
      AlarmForegroundService.stopRuntime(context)
    }
  }

  private fun scheduleRecord(context: Context, record: JSONObject): Boolean {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val at = record.optLong("at", 0L)
    if (at <= System.currentTimeMillis()) return false
    val requestCode = requestCode(record.optString("id", at.toString()))
    val broadcastIntent = Intent(context, MedicationAlarmReceiver::class.java).apply {
      action = ACTION_ALARM
      putExtra("recordJson", record.toString())
      putExtra("title", record.optString("title", "该吃药啦"))
      putExtra("body", record.optString("body", "请进入吃哟咯确认已吃药"))
      putExtra("sound", record.optString("sound", "default"))
      putExtra("itemId", record.optString("itemId", ""))
      putExtra("dueAt", record.optString("dueAt", ""))
    }
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
    val operation = PendingIntent.getBroadcast(context, requestCode, broadcastIntent, flags)
    val showIntent = Intent(context, MedicationAlarmActivity::class.java).apply {
      action = ACTION_ALARM
      putExtra("alarmMode", true)
      putExtra("itemId", record.optString("itemId", ""))
      putExtra("dueAt", record.optString("dueAt", ""))
      putExtra("title", record.optString("title", "该吃药啦"))
      putExtra("body", record.optString("body", "请进入吃哟咯确认已吃药"))
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
    return true
  }

  fun scheduleFollowing(context: Context, rawRecord: String) {
    try {
      val current = JSONObject(rawRecord)
      val next = nextRecord(current) ?: return
      val prefs = AlarmPermissionModule.preferences(context)
      val old = try { JSONArray(prefs.getString(AlarmPermissionModule.KEY_RECORDS, "[]") ?: "[]") } catch (_: Exception) { JSONArray() }
      val kept = JSONArray()
      val now = System.currentTimeMillis()
      for (index in 0 until old.length()) {
        val record = old.getJSONObject(index)
        if (record.optLong("at", 0L) > now) kept.put(record)
      }
      var duplicate = false
      for (index in 0 until kept.length()) {
        val record = kept.getJSONObject(index)
        if (record.optString("itemId") == next.optString("itemId") && record.optLong("at") == next.optLong("at")) duplicate = true
      }
      if (!duplicate) kept.put(next)
      prefs.edit().putString(AlarmPermissionModule.KEY_RECORDS, kept.toString()).apply()
      if (!duplicate) scheduleRecord(context, next)
      AlarmPermissionModule.recordEvent(context, "schedule_following")
    } catch (error: Exception) {
      AlarmPermissionModule.recordEvent(context, "schedule_following_failed_${error.javaClass.simpleName}")
    }
  }

  fun restore(context: Context) {
    val raw = AlarmPermissionModule.preferences(context).getString(AlarmPermissionModule.KEY_RECORDS, null) ?: return
    try {
      val records = JSONArray(raw)
      val now = System.currentTimeMillis()
      val restored = JSONArray()
      val latestByItem = mutableMapOf<String, JSONObject>()
      for (index in 0 until records.length()) {
        val record = records.getJSONObject(index)
        if (record.optLong("at", 0L) > now) restored.put(record)
        val itemId = record.optString("itemId", "")
        if (itemId.isNotBlank() && (!latestByItem.containsKey(itemId) || latestByItem[itemId]!!.optLong("at") < record.optLong("at"))) latestByItem[itemId] = record
      }
      latestByItem.values.forEach { record ->
        if (record.optLong("at", 0L) <= now) nextRecord(record)?.let { restored.put(it) }
      }
      scheduleRecords(context, restored)
    } catch (_: Exception) { }
  }

  private fun nextRecord(record: JSONObject): JSONObject? {
    val itemId = record.optString("itemId", "")
    if (itemId.isBlank()) return null
    val previous = record.optLong("at", System.currentTimeMillis())
    val mode = record.optString("mode", "fixed")
    val nextAt = if (mode == "interval") {
      val intervalHours = record.optDouble("intervalHours", 4.0).coerceAtLeast(0.25)
      var candidate = previous + (intervalHours * 60 * 60 * 1000).toLong()
      val step = (intervalHours * 60 * 60 * 1000).toLong()
      while (candidate <= System.currentTimeMillis()) candidate += step
      candidate
    } else nextFixedAt(record, previous) ?: return null
    return JSONObject(record.toString()).apply {
      put("id", "$itemId-$nextAt-following")
      put("at", nextAt)
      put("dueAt", iso(nextAt))
    }
  }

  private fun nextFixedAt(record: JSONObject, previous: Long): Long? {
    val times = record.optString("fixedTimes", "08:00").split(',').mapNotNull { value ->
      val parts = value.trim().split(':')
      if (parts.size != 2) null else {
        val hour = parts[0].toIntOrNull()
        val minute = parts[1].toIntOrNull()
        if (hour == null || minute == null) null else hour * 60 + minute
      }
    }.filter { it in 0..1439 }
    if (times.isEmpty()) return null
    val rule = record.optString("repeatRule", "daily")
    val weekdays = record.optString("weekdays", "1,2,3,4,5,6,7").split(',').mapNotNull { it.trim().toIntOrNull() }.toSet()
    val base = Calendar.getInstance().apply { timeInMillis = previous; add(Calendar.MINUTE, 1); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }
    for (dayOffset in 0..370) {
      val day = (base.clone() as Calendar).apply { add(Calendar.DAY_OF_YEAR, dayOffset) }
      val weekday = day.get(Calendar.DAY_OF_WEEK)
      if (rule != "daily" && !weekdays.contains(weekday)) continue
      for (minutes in times.sorted()) {
        val candidate = (day.clone() as Calendar).apply { set(Calendar.HOUR_OF_DAY, minutes / 60); set(Calendar.MINUTE, minutes % 60); set(Calendar.SECOND, 0); set(Calendar.MILLISECOND, 0) }
        if (candidate.timeInMillis > previous) return candidate.timeInMillis
      }
    }
    return null
  }

  private fun iso(at: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(at))

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
    intent.getStringExtra("recordJson")?.let { AlarmScheduler.scheduleFollowing(context, it) }
    AlarmForegroundService.startAlarm(
      context,
      intent.getStringExtra("title") ?: "该吃药啦",
      intent.getStringExtra("body") ?: "请进入吃哟咯确认已吃药",
      intent.getStringExtra("itemId") ?: "",
      intent.getStringExtra("dueAt") ?: System.currentTimeMillis().toString()
    )
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
