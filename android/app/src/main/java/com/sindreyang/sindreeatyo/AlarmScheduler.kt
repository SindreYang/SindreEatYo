package com.sindreyang.sindreeatyo

import android.app.AlarmManager
import android.app.AlarmManager.AlarmClockInfo
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import org.json.JSONArray
import org.json.JSONObject

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
        putExtra("notificationId", requestCode)
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
      val alarmInfo = AlarmClockInfo(at, showPendingIntent)
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !alarmManager.canScheduleExactAlarms()) {
          alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
          alarmManager.setAlarmClock(alarmInfo, operation)
        } else {
          alarmManager.setExact(AlarmManager.RTC_WAKEUP, at, operation)
        }
      } catch (_: SecurityException) {
        alarmManager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, operation)
      }
    }
  }

  fun restore(context: Context) {
    val raw = AlarmPermissionModule.preferences(context).getString(AlarmPermissionModule.KEY_RECORDS, null) ?: return
    try {
      scheduleRecords(context, JSONArray(raw))
    } catch (_: Exception) {
      // Keep boot processing best-effort; the app will recover missed doses on next launch.
    }
  }

  fun cancelAll(context: Context) {
    val alarmManager = context.getSystemService(Context.ALARM_SERVICE) as AlarmManager
    val raw = AlarmPermissionModule.preferences(context).getString(AlarmPermissionModule.KEY_RECORDS, null)
    if (raw != null) {
      try {
        val records = JSONArray(raw)
        for (index in 0 until records.length()) {
          val record = records.getJSONObject(index)
          val requestCode = requestCode(record.optString("id", index.toString()))
          val intent = Intent(context, MedicationAlarmReceiver::class.java).apply { action = ACTION_ALARM }
          val pending = PendingIntent.getBroadcast(context, requestCode, intent, PendingIntent.FLAG_NO_CREATE or immutableFlag())
          if (pending != null) {
            alarmManager.cancel(pending)
            pending.cancel()
          }
        }
      } catch (_: Exception) {
        // Ignore malformed old records.
      }
    }
  }

  private fun requestCode(value: String): Int = value.hashCode() and 0x7fffffff
  private fun immutableFlag(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
}
