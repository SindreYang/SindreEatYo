import * as Notifications from 'expo-notifications';
import { AndroidAudioContentType, AndroidAudioUsage } from 'expo-notifications';
import { Platform } from 'react-native';
import { NativeModules } from 'react-native';
import { ReminderSound, YoItem } from './types';
import { addDebugLog } from './debugLog';

type NativeAlarmRecord = {
  id: string;
  at: number;
  title: string;
  body: string;
  sound: ReminderSound;
  itemId: string;
  dueAt: string;
};

type NativeAlarmModule = {
  scheduleAlarms?: (recordsJson: string) => Promise<void>;
  cancelAllAlarms?: () => Promise<void>;
  getStatus?: () => Promise<{ exactAlarm: boolean; fullScreen: boolean; notifications: boolean; batteryOptimizationIgnored?: boolean; lastAlarmEvent?: string; lastAlarmAt?: string; backgroundServiceEnabled?: boolean; backgroundServiceRunning?: boolean }>;
  testAlarm?: () => Promise<void>;
  stopAlarm?: () => Promise<void>;
  startBackgroundService?: () => Promise<void>;
  stopBackgroundService?: () => Promise<void>;
  openBatteryOptimizationSettings?: () => Promise<void>;
  openAppDetailsSettings?: () => Promise<void>;
};

const nativeAlarm = NativeModules.EatYoAlarm as NativeAlarmModule | undefined;

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

const ALARM_CHANNEL_ID = 'eat-yo-alarm-v3';

export function channelIdFor(_sound: ReminderSound = 'default') {
  return ALARM_CHANNEL_ID;
}

export async function prepareNotifications(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync(ALARM_CHANNEL_ID, {
        name: '吃哟咯·闹钟提醒',
        importance: Notifications.AndroidImportance.MAX,
        bypassDnd: true,
        vibrationPattern: [0, 450, 120, 450],
        sound: 'default',
        audioAttributes: { usage: AndroidAudioUsage.ALARM, contentType: AndroidAudioContentType.SONIFICATION, flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false } },
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      });
    }
    const current = await Notifications.getPermissionsAsync();
    if (!current.granted) {
      const requested = await Notifications.requestPermissionsAsync();
      await addDebugLog('notification_permission_requested', { granted: requested.granted });
      return requested.granted;
    }
    await addDebugLog('notification_permission_ready', { granted: true });
    return true;
  } catch (error) {
    await addDebugLog('notification_prepare_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
    return false;
  }
}

export function notificationContent(item: YoItem) {
  return {
    title: `该吃药啦：${item.name}`,
    body: item.note ? `${item.note}\n请进入吃哟咯确认已吃药` : '请进入吃哟咯确认已吃药',
    sound: 'default',
    priority: 'max',
    sticky: true,
    autoDismiss: false,
    vibrate: [0, 450, 120, 450],
    data: { itemId: item.id, action: 'dose-due', alarmMode: true },
    ...(Platform.OS === 'android' ? { channelId: ALARM_CHANNEL_ID } : {}),
  };
}

function dailyTrigger(hour: number, minute: number) {
  return {
    type: Notifications.SchedulableTriggerInputTypes.DAILY,
    hour,
    minute,
  } as Notifications.NotificationTriggerInput;
}

function weeklyTrigger(weekday: number, hour: number, minute: number) {
  return {
    type: Notifications.SchedulableTriggerInputTypes.WEEKLY,
    weekday,
    hour,
    minute,
  } as Notifications.NotificationTriggerInput;
}

function intervalTrigger(seconds: number) {
  return {
    type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
    seconds,
    repeats: true,
  } as Notifications.NotificationTriggerInput;
}

function addNativeRecord(records: NativeAlarmRecord[], item: YoItem, dueAt: Date, suffix: string) {
  if (dueAt.getTime() <= Date.now()) return;
  records.push({
    id: `${item.id}-${dueAt.getTime()}-${suffix}`,
    at: dueAt.getTime(),
    title: `该吃药啦：${item.name}`,
    body: item.note ? `${item.note}\n请进入吃哟咯确认已吃药` : '请进入吃哟咯确认已吃药',
    sound: 'default',
    itemId: item.id,
    dueAt: dueAt.toISOString(),
  });
}

function nativeRecordsFor(items: YoItem[]): NativeAlarmRecord[] {
  const now = new Date();
  const records: NativeAlarmRecord[] = [];
  const horizon = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  for (const item of items.filter((candidate) => candidate.enabled && candidate.name.trim())) {
    if (item.mode === 'interval') {
      const intervalMs = Math.max(15 * 60 * 1000, item.intervalHours * 60 * 60 * 1000);
      const origin = new Date(item.createdAt).getTime();
      let due = Number.isFinite(origin) ? new Date(origin) : new Date(now);
      if (due <= now) {
        const steps = Math.floor((now.getTime() - due.getTime()) / intervalMs) + 1;
        due = new Date(due.getTime() + steps * intervalMs);
      }
      for (let index = 0; index < 30; index += 1) {
        addNativeRecord(records, item, due, `first-${index}`);
        due = new Date(due.getTime() + intervalMs);
      }
      continue;
    }

    const cursor = new Date(now);
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= horizon) {
      const weekday = cursor.getDay() + 1;
      const applies = item.repeatRule === 'daily' || item.weekdays.includes(weekday);
      if (applies) {
        for (const time of item.fixedTimes) {
          const [hour, minute] = time.split(':').map(Number);
          if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
          const due = new Date(cursor);
          due.setHours(hour, minute, 0, 0);
          addNativeRecord(records, item, due, 'first');
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return records;
}

export async function rescheduleAll(items: YoItem[]): Promise<void> {
  if (Platform.OS === 'android' && nativeAlarm?.scheduleAlarms) {
    const records = nativeRecordsFor(items);
    try {
      await nativeAlarm.scheduleAlarms(JSON.stringify(records));
      await addDebugLog('native_alarms_scheduled', { itemCount: items.length, alarmCount: records.length });
    } catch (error) {
      await addDebugLog('native_alarm_schedule_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
      throw error;
    }
    return;
  }
  try {
    await Notifications.cancelAllScheduledNotificationsAsync();
    for (const item of items.filter((candidate) => candidate.enabled && candidate.name.trim())) {
    if (item.mode === 'interval') {
      const seconds = Math.max(15 * 60, item.intervalHours * 60 * 60);
      await Notifications.scheduleNotificationAsync({ content: notificationContent(item), trigger: intervalTrigger(seconds) });
      continue;
    }

    for (const time of item.fixedTimes) {
      const [hourString, minuteString] = time.split(':');
      const hour = Number(hourString);
      const minute = Number(minuteString);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
      const weekdays = item.repeatRule === 'daily' ? [0] : item.weekdays;
      for (const weekday of weekdays) {
        const trigger = item.repeatRule === 'daily' ? dailyTrigger(hour, minute) : weeklyTrigger(weekday, hour, minute);
        await Notifications.scheduleNotificationAsync({ content: notificationContent(item), trigger });
      }
    }
    }
    await addDebugLog('expo_alarms_scheduled', { itemCount: items.length });
  } catch (error) {
    await addDebugLog('expo_alarm_schedule_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
    throw error;
  }
}

export async function getNativeAlarmStatus() {
  if (Platform.OS !== 'android' || !nativeAlarm?.getStatus) return null;
  try {
    const status = await nativeAlarm.getStatus();
    await addDebugLog('alarm_permission_status', status);
    return status;
  } catch (error) {
    await addDebugLog('alarm_permission_status_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
    return null;
  }
}

export async function openBatteryOptimizationSettings() {
  if (Platform.OS === 'android' && nativeAlarm?.openBatteryOptimizationSettings) await nativeAlarm.openBatteryOptimizationSettings();
}

export async function openAppDetailsSettings() {
  if (Platform.OS === 'android' && nativeAlarm?.openAppDetailsSettings) await nativeAlarm.openAppDetailsSettings();
}

export async function testAlarm() {
  try {
    if (Platform.OS === 'android' && nativeAlarm?.testAlarm) {
      await nativeAlarm.testAlarm();
      await addDebugLog('test_alarm_sent', { native: true });
      return true;
    }
    await Notifications.scheduleNotificationAsync({ content: notificationContent({ ...({} as YoItem), id: 'test', name: '测试提醒', note: '', sound: 'default' }), trigger: null });
    await addDebugLog('test_alarm_sent', { native: false });
    return true;
  } catch (error) {
    await addDebugLog('test_alarm_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
    throw error;
  }
}

export async function stopAlarm() {
  if (Platform.OS === 'android' && nativeAlarm?.stopAlarm) await nativeAlarm.stopAlarm();
}

export async function setBackgroundServiceEnabled(enabled: boolean) {
  if (Platform.OS !== 'android') return;
  if (enabled) await nativeAlarm?.startBackgroundService?.();
  else await nativeAlarm?.stopBackgroundService?.();
  await addDebugLog('background_service_requested', { enabled });
}
