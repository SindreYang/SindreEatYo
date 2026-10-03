package com.sindreyang.sindreeatyo

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.MediaPlayer
import android.media.Ringtone
import android.media.RingtoneManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.PowerManager
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

class AlarmForegroundService : Service() {
  private val handler = Handler(Looper.getMainLooper())
  private var ringtone: Ringtone? = null
  private var mediaPlayer: MediaPlayer? = null
  private var audioManager: AudioManager? = null
  private var audioFocusRequest: AudioFocusRequest? = null
  private var vibrator: Vibrator? = null
  private var currentNotificationId: Int? = null
  private var activeTitle: String? = null
  private var activeBody: String? = null
  private var activeItemId: String? = null
  private var activeDueAt: String? = null

  override fun onCreate() {
    super.onCreate()
    running = true
    createChannels()
    restoreActiveAlarm()
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    when (intent?.action) {
      ACTION_START_ALARM -> startAlarm(intent)
      ACTION_STOP_ALARM -> stopCurrentAlarm()
      else -> if (!hasActiveAlarm()) startBackgroundNotification()
    }
    return START_STICKY
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    stopAlertBurst()
    running = false
    super.onDestroy()
  }

  override fun onBind(intent: Intent?): IBinder? = null

  private fun startBackgroundNotification() {
    if (hasActiveAlarm()) return
    val notification = NotificationCompat.Builder(this, BACKGROUND_CHANNEL)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle("吃哟咯正在后台提醒")
      .setContentText("到吃药时间会响铃并振动")
      .setCategory(NotificationCompat.CATEGORY_SERVICE)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_LOW)
      .setContentIntent(openAppPendingIntent())
      .build()
    startAsForeground(BACKGROUND_NOTIFICATION_ID, notification)
    AlarmPermissionModule.recordEvent(this, "background_service_started")
  }

  private fun startAlarm(intent: Intent) {
    activeTitle = intent.getStringExtra(EXTRA_TITLE) ?: "该吃药啦"
    activeBody = intent.getStringExtra(EXTRA_BODY) ?: "请进入吃哟咯确认已吃药"
    activeItemId = intent.getStringExtra(EXTRA_ITEM_ID) ?: ""
    activeDueAt = intent.getStringExtra(EXTRA_DUE_AT) ?: System.currentTimeMillis().toString()
    saveActiveAlarm()
    activateAlarm()
    AlarmPermissionModule.recordEvent(this, "alarm_service_started")
    if (intent.getBooleanExtra(EXTRA_TEST, false)) handler.postDelayed({ stopCurrentAlarm() }, TEST_DURATION_MS)
  }

  private fun activateAlarm() {
    val title = activeTitle ?: return
    val body = activeBody ?: return
    val itemId = activeItemId ?: ""
    val dueAt = activeDueAt ?: System.currentTimeMillis().toString()
    val notification = alarmNotification(title, body, itemId, dueAt)
    startAsForeground(ALARM_NOTIFICATION_ID, notification)
    (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(ALARM_NOTIFICATION_ID, notification)
    currentNotificationId = ALARM_NOTIFICATION_ID
    ringOnce()
  }

  private fun hasActiveAlarm(): Boolean = activeTitle != null

  private fun saveActiveAlarm() {
    AlarmPermissionModule.preferences(this).edit()
      .putBoolean(KEY_ACTIVE_ALARM, true)
      .putString(KEY_ACTIVE_TITLE, activeTitle)
      .putString(KEY_ACTIVE_BODY, activeBody)
      .putString(KEY_ACTIVE_ITEM_ID, activeItemId)
      .putString(KEY_ACTIVE_DUE_AT, activeDueAt)
      .apply()
  }

  private fun restoreActiveAlarm() {
    val prefs = AlarmPermissionModule.preferences(this)
    if (!prefs.getBoolean(KEY_ACTIVE_ALARM, false)) return
    activeTitle = prefs.getString(KEY_ACTIVE_TITLE, null)
    activeBody = prefs.getString(KEY_ACTIVE_BODY, null)
    activeItemId = prefs.getString(KEY_ACTIVE_ITEM_ID, "")
    activeDueAt = prefs.getString(KEY_ACTIVE_DUE_AT, "")
    if (hasActiveAlarm()) activateAlarm()
  }

  private fun alarmNotification(title: String, body: String, itemId: String, dueAt: String): Notification {
    val intent = Intent(this, MedicationAlarmActivity::class.java).apply {
      putExtra(EXTRA_TITLE, title)
      putExtra(EXTRA_BODY, body)
      putExtra(EXTRA_ITEM_ID, itemId)
      putExtra(EXTRA_DUE_AT, dueAt)
      addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }
    val requestCode = ("$itemId-$dueAt".hashCode() and 0x7fffffff)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag()
    val fullScreen = PendingIntent.getActivity(this, requestCode, intent, flags)
    return NotificationCompat.Builder(this, ALARM_CHANNEL)
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setOngoing(true)
      .setAutoCancel(false)
      .setFullScreenIntent(fullScreen, true)
      .setContentIntent(fullScreen)
      .setVibrate(longArrayOf(0, 450, 120, 450))
      .build()
  }

  private fun ringOnce() {
    handler.removeCallbacks(RING_NEXT_CALLBACK)
    stopAlertBurst()
    val attributes = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
      .build()
    val uri = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
    if (uri != null) {
      try {
        audioManager = getSystemService(Context.AUDIO_SERVICE) as AudioManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          audioFocusRequest = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
            .setAudioAttributes(attributes)
            .build()
          audioManager?.requestAudioFocus(audioFocusRequest!!)
        } else {
          @Suppress("DEPRECATION")
          audioManager?.requestAudioFocus(null, AudioManager.STREAM_ALARM, AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE)
        }
        mediaPlayer = MediaPlayer().apply {
          setAudioAttributes(attributes)
          setWakeMode(this@AlarmForegroundService, PowerManager.PARTIAL_WAKE_LOCK)
          setDataSource(this@AlarmForegroundService, uri)
          isLooping = true
          prepare()
          start()
        }
        AlarmPermissionModule.recordEvent(this, "ringtone_started")
      } catch (error: Exception) {
        AlarmPermissionModule.recordEvent(this, "ringtone_failed_${error.javaClass.simpleName}")
        mediaPlayer?.release()
        mediaPlayer = null
        ringtone = RingtoneManager.getRingtone(this, uri)
        ringtone?.audioAttributes = attributes
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) ringtone?.isLooping = true
        ringtone?.play()
        AlarmPermissionModule.recordEvent(this, "ringtone_fallback")
      }
    }
    vibrator = getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
    if (vibrator?.hasVibrator() == true) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) vibrator?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 450, 120, 450), -1))
      else {
        @Suppress("DEPRECATION")
        vibrator?.vibrate(longArrayOf(0, 450, 120, 450), -1)
      }
      AlarmPermissionModule.recordEvent(this, "vibration_started")
    }
    handler.postDelayed({ stopAlertBurst() }, RING_BURST_MS)
    handler.postDelayed(RING_NEXT_CALLBACK, RING_INTERVAL_MS)
  }

  private val RING_NEXT_CALLBACK = Runnable { if (hasActiveAlarm()) ringOnce() }

  private fun stopAlertBurst() {
    try {
      mediaPlayer?.let { if (it.isPlaying) it.stop(); it.reset(); it.release() }
    } catch (_: Exception) { }
    mediaPlayer = null
    ringtone?.stop()
    ringtone = null
    vibrator?.cancel()
    vibrator = null
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) audioFocusRequest?.let { audioManager?.abandonAudioFocusRequest(it) }
    else {
      @Suppress("DEPRECATION")
      audioManager?.abandonAudioFocus(null)
    }
    audioFocusRequest = null
    audioManager = null
  }

  private fun stopCurrentAlarm() {
    handler.removeCallbacksAndMessages(null)
    stopAlertBurst()
    activeTitle = null
    activeBody = null
    activeItemId = null
    activeDueAt = null
    AlarmPermissionModule.preferences(this).edit()
      .putBoolean(KEY_ACTIVE_ALARM, false)
      .remove(KEY_ACTIVE_TITLE)
      .remove(KEY_ACTIVE_BODY)
      .remove(KEY_ACTIVE_ITEM_ID)
      .remove(KEY_ACTIVE_DUE_AT)
      .apply()
    currentNotificationId?.let { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(it) }
    currentNotificationId = null
    AlarmPermissionModule.recordEvent(this, "alarm_stopped")
    if (AlarmPermissionModule.preferences(this).getBoolean(AlarmPermissionModule.KEY_BACKGROUND_SERVICE, true)) startBackgroundNotification() else stopSelf()
  }

  private fun startAsForeground(id: Int, notification: Notification) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
      startForeground(id, notification, android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE)
    } else {
      startForeground(id, notification)
    }
  }

  private fun openAppPendingIntent(): PendingIntent {
    val intent = Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(this, 7001, intent, PendingIntent.FLAG_UPDATE_CURRENT or immutableFlag())
  }

  private fun createChannels() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    val attributes = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
    val alarm = NotificationChannel(ALARM_CHANNEL, "吃哟咯·闹钟提醒", NotificationManager.IMPORTANCE_HIGH).apply {
      description = "锁屏时显示并提醒吃药"
      enableVibration(true)
      vibrationPattern = longArrayOf(0, 450, 120, 450)
      setSound(null, attributes)
      lockscreenVisibility = NotificationCompat.VISIBILITY_PUBLIC
    }
    val background = NotificationChannel(BACKGROUND_CHANNEL, "吃哟咯·后台提醒", NotificationManager.IMPORTANCE_LOW).apply {
      description = "保持吃药提醒在后台运行"
      setSound(null, attributes)
      enableVibration(false)
      lockscreenVisibility = NotificationCompat.VISIBILITY_PRIVATE
    }
    manager.createNotificationChannel(alarm)
    manager.createNotificationChannel(background)
  }

  companion object {
    const val ACTION_START_BACKGROUND = "com.sindreyang.sindreeatyo.START_BACKGROUND"
    const val ACTION_START_ALARM = "com.sindreyang.sindreeatyo.START_ALARM"
    const val ACTION_STOP_ALARM = "com.sindreyang.sindreeatyo.STOP_ALARM"
    const val EXTRA_TITLE = "title"
    const val EXTRA_BODY = "body"
    const val EXTRA_ITEM_ID = "itemId"
    const val EXTRA_DUE_AT = "dueAt"
    const val EXTRA_TEST = "testAlarm"
    private const val ALARM_CHANNEL = "eat-yo-native-alarm-v4"
    private const val BACKGROUND_CHANNEL = "eat-yo-native-background-v1"
    private const val ALARM_NOTIFICATION_ID = 7021
    private const val BACKGROUND_NOTIFICATION_ID = 7022
    private const val RING_BURST_MS = 10_000L
    private const val RING_INTERVAL_MS = 60_000L
    private const val TEST_DURATION_MS = 10_000L
    private const val KEY_ACTIVE_ALARM = "active_alarm"
    private const val KEY_ACTIVE_TITLE = "active_alarm_title"
    private const val KEY_ACTIVE_BODY = "active_alarm_body"
    private const val KEY_ACTIVE_ITEM_ID = "active_alarm_item_id"
    private const val KEY_ACTIVE_DUE_AT = "active_alarm_due_at"
    private var running = false

    fun isRunning(): Boolean = running

    fun startBackground(context: Context) {
      startCompat(context, Intent(context, AlarmForegroundService::class.java).setAction(ACTION_START_BACKGROUND))
    }

    fun stopBackground(context: Context) {
      AlarmPermissionModule.preferences(context).edit().putBoolean(AlarmPermissionModule.KEY_BACKGROUND_SERVICE, false).apply()
      context.stopService(Intent(context, AlarmForegroundService::class.java))
      AlarmPermissionModule.recordEvent(context, "background_service_stopped")
    }

    fun stopRuntime(context: Context) {
      context.stopService(Intent(context, AlarmForegroundService::class.java))
    }

    fun startAlarm(context: Context, title: String, body: String, itemId: String, dueAt: String, test: Boolean = false) {
      val intent = Intent(context, AlarmForegroundService::class.java).apply {
        action = ACTION_START_ALARM
        putExtra(EXTRA_TITLE, title)
        putExtra(EXTRA_BODY, body)
        putExtra(EXTRA_ITEM_ID, itemId)
        putExtra(EXTRA_DUE_AT, dueAt)
        putExtra(EXTRA_TEST, test)
      }
      startCompat(context, intent)
    }

    fun stopActive(context: Context) {
      startCompat(context, Intent(context, AlarmForegroundService::class.java).setAction(ACTION_STOP_ALARM))
    }

    private fun startCompat(context: Context, intent: Intent) {
      try {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) ContextCompat.startForegroundService(context, intent) else context.startService(intent)
      } catch (error: Exception) {
        AlarmPermissionModule.recordEvent(context, "foreground_service_failed_${error.javaClass.simpleName}")
      }
    }

    private fun immutableFlag(): Int = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0
  }
}

class MedicationAlarmActivity : Activity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    prepareWindow()
    showContent()
    AlarmPermissionModule.recordEvent(this, "alarm_activity_created")
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    setIntent(intent)
    showContent()
  }

  private fun prepareWindow() {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
    window.setBackgroundDrawable(ColorDrawable(Color.WHITE))
  }

  private fun showContent() {
    val title = intent.getStringExtra(AlarmForegroundService.EXTRA_TITLE) ?: "该吃药啦"
    val body = intent.getStringExtra(AlarmForegroundService.EXTRA_BODY) ?: "请进入吃哟咯确认已吃药"
    val itemId = intent.getStringExtra(AlarmForegroundService.EXTRA_ITEM_ID) ?: ""
    val dueAt = intent.getStringExtra(AlarmForegroundService.EXTRA_DUE_AT) ?: ""
    val root = LinearLayout(this).apply {
      orientation = LinearLayout.VERTICAL
      gravity = Gravity.CENTER
      setPadding(48, 56, 48, 56)
    }
    val heading = TextView(this).apply {
      text = "吃哟咯"
      textSize = 22f
      setTextColor(Color.rgb(45, 45, 45))
      gravity = Gravity.CENTER
    }
    val titleView = TextView(this).apply {
      text = title
      textSize = 30f
      setTextColor(Color.rgb(35, 35, 35))
      gravity = Gravity.CENTER
      setPadding(0, 28, 0, 16)
    }
    val bodyView = TextView(this).apply {
      text = body
      textSize = 18f
      setTextColor(Color.rgb(110, 100, 100))
      gravity = Gravity.CENTER
      setPadding(0, 0, 0, 36)
    }
    val open = Button(this).apply {
      text = "打开吃哟咯"
      minHeight = 54
      setOnClickListener {
        startActivity(Intent(this@MedicationAlarmActivity, MainActivity::class.java).apply {
          action = "com.sindreyang.sindreeatyo.MEDICATION_ALARM"
          putExtra("alarmMode", true)
          putExtra("itemId", itemId)
          putExtra("dueAt", dueAt)
          addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        finish()
      }
    }
    root.addView(heading, LinearLayout.LayoutParams(-1, -2))
    root.addView(titleView, LinearLayout.LayoutParams(-1, -2))
    root.addView(bodyView, LinearLayout.LayoutParams(-1, -2))
    root.addView(open, LinearLayout.LayoutParams(-1, -2).apply { topMargin = 12 })
    setContentView(root)
  }
}
