import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppData, emptyItem, PendingDose, YoItem } from './types';

const KEY = '@sindre_eat_yo/data/v1';

export async function loadData(): Promise<AppData> {
  const raw = await AsyncStorage.getItem(KEY);
  if (!raw) return { items: [], pendingDoses: [] };
  try {
    const parsed = JSON.parse(raw) as Partial<AppData>;
    const items = Array.isArray(parsed.items) ? parsed.items.map((item) => ({ ...emptyItem(), ...(item as Partial<YoItem>), sound: (item as Partial<YoItem>).sound ?? 'default' })) : [];
    const itemIds = new Set(items.map((item) => item.id));
    const pendingDoses = Array.isArray(parsed.pendingDoses) ? parsed.pendingDoses
      .filter((dose) => itemIds.has(String((dose as Partial<{ itemId: string }>).itemId)))
      .map((dose) => ({ ...dose, status: (dose as Partial<PendingDose>).status === 'snoozed' ? 'pending' : (dose as Partial<PendingDose>).status })) : [];
    return {
      items,
      pendingDoses: pendingDoses as AppData['pendingDoses'],
      lastCheckedAt: typeof parsed.lastCheckedAt === 'string' ? parsed.lastCheckedAt : undefined,
    };
  } catch {
    return { items: [], pendingDoses: [] };
  }
}

export function saveData(data: AppData): Promise<void> {
  return AsyncStorage.setItem(KEY, JSON.stringify(data));
}
