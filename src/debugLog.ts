import AsyncStorage from '@react-native-async-storage/async-storage';
import { Share } from 'react-native';

const LOG_KEY = '@sindre_eat_yo/debug-log/v1';
const MAX_ENTRIES = 160;

type DebugEntry = {
  time: string;
  level: 'info' | 'warn' | 'error';
  event: string;
  detail?: Record<string, string | number | boolean | null>;
};

function safeDetail(detail?: Record<string, unknown>) {
  if (!detail) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(detail)) {
    if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') result[key] = value;
  }
  return result;
}

export async function addDebugLog(event: string, detail?: Record<string, unknown>, level: DebugEntry['level'] = 'info') {
  const entry: DebugEntry = { time: new Date().toISOString(), level, event, detail: safeDetail(detail) };
  try {
    const raw = await AsyncStorage.getItem(LOG_KEY);
    const entries = raw ? JSON.parse(raw) as DebugEntry[] : [];
    const next = [...(Array.isArray(entries) ? entries : []), entry].slice(-MAX_ENTRIES);
    await AsyncStorage.setItem(LOG_KEY, JSON.stringify(next));
  } catch {
    // Logging must never interrupt medication reminders.
  }
}

export async function exportDebugLog() {
  const raw = await AsyncStorage.getItem(LOG_KEY);
  const entries = raw ? JSON.parse(raw) as DebugEntry[] : [];
  const lines = [
    '吃哟咯 Android 调试日志',
    `导出时间: ${new Date().toISOString()}`,
    '说明: 日志不包含药品名称和备注。',
    '',
    ...(Array.isArray(entries) ? entries : []).map((entry) => `${entry.time} [${entry.level}] ${entry.event}${entry.detail ? ` ${JSON.stringify(entry.detail)}` : ''}`),
  ];
  await Share.share({ title: '吃哟咯调试日志', message: lines.join('\n') });
}

export async function clearDebugLog() {
  await AsyncStorage.removeItem(LOG_KEY);
}
