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
  getStatus?: () => Promise<{ exactAlarm: boolean; fullScreen: boolean; notifications: boolean }>;
  testAlarm?: () => Promise<void>;
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

export const soundLabels: Record<ReminderSound, string> = {
  default: '系统默认',
  gentle: '轻柔提示',
  urgent: '强提醒',
};

export function channelIdFor(sound: ReminderSound = 'default') {
  // A new channel id is intentional: Android permanently keeps the user's
  // old channel sound/importance settings, even after the app code changes.
  return `eat-yo-v2-${sound}`;
}

function soundFileFor(sound: ReminderSound = 'default'): string {
  if (sound === 'default') return 'default';
  return `${sound}.wav`;
}

export async function prepareNotifications(): Promise<boolean> {
  try {
    if (Platform.OS === 'android') {
      await Promise.all([
      Notifications.setNotificationChannelAsync(channelIdFor('default'), {
        name: '吃哟咯·系统默认',
        importance: Notifications.AndroidImportance.MAX,
        bypassDnd: true,
        vibrationPattern: [0, 250, 150, 250],
        sound: 'default',
        audioAttributes: { usage: AndroidAudioUsage.ALARM, contentType: AndroidAudioContentType.SONIFICATION, flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false } },
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      }),
      Notifications.setNotificationChannelAsync(channelIdFor('gentle'), {
        name: '吃哟咯·轻柔提示',
        importance: Notifications.AndroidImportance.DEFAULT,
        bypassDnd: false,
        vibrationPattern: [0, 160],
        sound: 'gentle.wav',
        audioAttributes: { usage: AndroidAudioUsage.ALARM, contentType: AndroidAudioContentType.SONIFICATION },
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      }),
      Notifications.setNotificationChannelAsync(channelIdFor('urgent'), {
        name: '吃哟咯·强提醒',
        importance: Notifications.AndroidImportance.MAX,
        bypassDnd: true,
        vibrationPattern: [0, 400, 120, 400],
        sound: 'urgent.wav',
        audioAttributes: { usage: AndroidAudioUsage.ALARM, contentType: AndroidAudioContentType.SONIFICATION, flags: { enforceAudibility: true, requestHardwareAudioVideoSynchronization: false } },
        lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
      }),
      ]);
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
  const sound = item.sound ?? 'default';
  return {
    title: `该吃药啦：${item.name}`,
    body: item.note ? `${item.note}\n请进入吃哟咯确认已吃药` : '请进入吃哟咯确认已吃药',
    sound: soundFileFor(sound),
    priority: sound === 'urgent' || sound === 'default' ? 'max' : 'high',
    sticky: true,
    autoDismiss: false,
    vibrate: sound === 'urgent' ? [0, 450, 120, 450] : [0, 250],
    data: { itemId: item.id, action: 'dose-due', alarmMode: true },
    ...(Platform.OS === 'android' ? { channelId: channelIdFor(sound) } : {}),
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
    sound: item.sound ?? 'default',
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
        if (item.bellCount === 2) addNativeRecord(records, item, new Date(due.getTime() + Math.max(1, item.secondBellDelayMinutes) * 60 * 1000), `second-${index}`);
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
          if (item.bellCount === 2) addNativeRecord(records, item, new Date(due.getTime() + Math.max(1, item.secondBellDelayMinutes) * 60 * 1000), 'second');
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
      if (item.bellCount === 2) {
        const delay = Math.max(1, item.secondBellDelayMinutes) * 60;
        await Notifications.scheduleNotificationAsync({ content: notificationContent(item), trigger: intervalTrigger(seconds + delay) });
      }
      continue;
    }

    for (const time of item.fixedTimes) {
      const [hourString, minuteString] = time.split(':');
      const hour = Number(hourString);
      const minute = Number(minuteString);
      if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
      const total = hour * 60 + minute + Math.max(1, item.secondBellDelayMinutes);
      const secondHour = Math.floor((total % 1440) / 60);
      const secondMinute = total % 60;
      const weekdays = item.repeatRule === 'daily' ? [0] : item.weekdays;
      for (const weekday of weekdays) {
        const trigger = item.repeatRule === 'daily' ? dailyTrigger(hour, minute) : weeklyTrigger(weekday, hour, minute);
        await Notifications.scheduleNotificationAsync({ content: notificationContent(item), trigger });
        if (item.bellCount === 2) {
          const secondTrigger = item.repeatRule === 'daily' ? dailyTrigger(secondHour, secondMinute) : weeklyTrigger(weekday, secondHour, secondMinute);
          await Notifications.scheduleNotificationAsync({ content: notificationContent(item), trigger: secondTrigger });
        }
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

export async function testAlarm() {
  try {
    if (Platform.OS === 'android' && nativeAlarm?.testAlarm) {
      await nativeAlarm.testAlarm();
      await addDebugLog('test_alarm_sent', { native: true });
      return true;
    }
    await Notifications.scheduleNotificationAsync({ content: notificationContent({ ...({} as YoItem), id: 'test', name: '测试提醒', note: '', sound: 'urgent' }), trigger: null });
    await addDebugLog('test_alarm_sent', { native: false });
    return true;
  } catch (error) {
    await addDebugLog('test_alarm_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
    throw error;
  }
}
