import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { YoItem } from './types';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export async function prepareNotifications(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.setNotificationChannelAsync('eat-yo', {
      name: '吃哟提醒',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 250, 150, 250],
      sound: 'default',
      lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }
  const current = await Notifications.getPermissionsAsync();
  if (!current.granted) {
    const requested = await Notifications.requestPermissionsAsync();
    return requested.granted;
  }
  return true;
}

function content(item: YoItem) {
  return {
    title: `该吃哟啦：${item.name}`,
    body: item.note ? `${item.note}\n请进入 SindreEatYo 确认已吃哟` : '请进入 SindreEatYo 确认已吃哟',
    sound: 'default' as const,
    data: { itemId: item.id, action: 'dose-due' },
    ...(Platform.OS === 'android' ? { channelId: 'eat-yo' } : {}),
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
      await Notifications.scheduleNotificationAsync({ content: content(item), trigger: intervalTrigger(seconds) });
      if (item.bellCount === 2) {
        const delay = Math.max(1, item.secondBellDelayMinutes) * 60;
        await Notifications.scheduleNotificationAsync({ content: content(item), trigger: intervalTrigger(seconds + delay) });
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
        await Notifications.scheduleNotificationAsync({ content: content(item), trigger });
        if (item.bellCount === 2) {
          const secondTrigger = item.repeatRule === 'daily' ? dailyTrigger(secondHour, secondMinute) : weeklyTrigger(weekday, secondHour, secondMinute);
          await Notifications.scheduleNotificationAsync({ content: content(item), trigger: secondTrigger });
        }
      }
    }
  }
}
