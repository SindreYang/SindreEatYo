import * as Notifications from 'expo-notifications';
import { AndroidAudioContentType, AndroidAudioUsage } from 'expo-notifications';
import { Platform } from 'react-native';
import { ReminderSound, YoItem } from './types';

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
  return `eat-yo-${sound}`;
}

function soundFileFor(sound: ReminderSound = 'default'): string {
  if (sound === 'default') return 'default';
  return `${sound}.wav`;
}

export async function prepareNotifications(): Promise<boolean> {
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
    return requested.granted;
  }
  return true;
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

export async function rescheduleAll(items: YoItem[]): Promise<void> {
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
}