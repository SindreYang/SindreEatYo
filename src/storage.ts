import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppData, emptyItem, YoItem } from './types';

const KEY = '@sindre_eat_yo/data/v1';

export async function loadData(): Promise<AppData> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return { items: [], pendingDoses: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<AppData>;
    return {
      items: Array.isArray(parsed.items) ? parsed.items.map((item) => ({ ...emptyItem(), ...(item as Partial<YoItem>), sound: (item as Partial<YoItem>).sound ?? 'default' })) : [],
      pendingDoses: Array.isArray(parsed.pendingDoses) ? parsed.pendingDoses : [],
    };
  } catch {
    return { items: [], pendingDoses: [] };
  }
}

export function saveData(data: AppData): Promise<void> {
  return AsyncStorage.setItem(KEY, JSON.stringify(data));
}