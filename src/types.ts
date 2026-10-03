export type ReminderMode = 'interval' | 'fixed';
export type RepeatRule = 'daily' | 'weekly' | 'custom';

export interface YoItem {
  id: string;
  name: string;
  note: string;
  mode: ReminderMode;
  intervalHours: number;
  fixedTimes: string[];
  repeatRule: RepeatRule;
  weekdays: number[];
  bellCount: 1 | 2;
  secondBellDelayMinutes: number;
  enabled: boolean;
  createdAt: string;
}

export interface PendingDose {
  id: string;
  itemId: string;
  dueAt: string;
  status: 'pending' | 'confirmed' | 'snoozed';
  confirmedAt?: string;
}

export interface AppData {
  items: YoItem[];
  pendingDoses: PendingDose[];
}

export const emptyItem = (): YoItem => ({
  id: '',
  name: '',
  note: '',
  mode: 'interval',
  intervalHours: 4,
  fixedTimes: ['08:00'],
  repeatRule: 'daily',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  bellCount: 1,
  secondBellDelayMinutes: 10,
  enabled: true,
  createdAt: new Date().toISOString(),
});
