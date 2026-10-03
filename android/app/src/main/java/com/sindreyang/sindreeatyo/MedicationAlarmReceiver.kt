package com.sindreyang.sindreeatyo

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat

class MedicationAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    postNotification(
      context,
      intent.getStringExtra("title") ?: "该吃药啦",
      intent.getStringExtra("body") ?: "请进入吃哟咯确认已吃药",
      intent.getStringExtra("sound") ?: "default",
      intent.getStringExtra("itemId") ?: "",
      intent.getStringExtra("dueAt") ?: System.currentTimeMillis().toString()
    )
  }

  companion object {
    private const val DEFAULT_CHANNEL = "eat-yo-native-default-v2"
    private const val GENTLE_CHANNEL = "eat-yo-native-gentle-v2"
    private const val URGENT_CHANNEL = "eat-yo-native-urgent-v2"

    fun postNotification(context: Context, title: String, body: String, sound: String, itemId: String, dueAt: String) {
      val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      createChannels(context, manager)
      val channel = when (sound) {
        "gentle" -> GENTLE_CHANNEL
        "urgent" -> URGENT_CHANNEL
        else -> DEFAULT_CHANNEL
      }
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
        description = "吃药时间提醒"
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 250, 150, 250)
        setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), alarmAttributes)
        lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      val gentle = NotificationChannel(GENTLE_CHANNEL, "吃哟咯·轻柔提示", NotificationManager.IMPORTANCE_HIGH).apply {
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 160)
        setSound(Uri.parse("android.resource://${context.packageName}/${context.resources.getIdentifier("gentle", "raw", context.packageName)}"), alarmAttributes)
        lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      val urgent = NotificationChannel(URGENT_CHANNEL, "吃哟咯·强提醒", NotificationManager.IMPORTANCE_HIGH).apply {
        enableVibration(true)
        vibrationPattern = longArrayOf(0, 450, 120, 450)
        setSound(Uri.parse("android.resource://${context.packageName}/${context.resources.getIdentifier("urgent", "raw", context.packageName)}"), alarmAttributes)
        lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
      }
      manager.createNotificationChannels(listOf(default, gentle, urgent))
    }
  }
}
