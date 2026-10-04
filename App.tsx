import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  AppState,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { emptyItem, PendingDose, AppData, YoItem } from './src/types';
import { loadData, saveData } from './src/storage';
import { consumeConfirmedDoses, getNativeAlarmStatus, notificationContent, openBatteryOptimizationSettings, prepareNotifications, rescheduleAll, setBackgroundServiceEnabled, stopAlarm, testAlarm } from './src/notifications';
import { addDebugLog, exportDebugLog } from './src/debugLog';

type Tab = 'today' | 'items' | 'settings';
type PickerKind = 'interval' | 'time' | null;

const colors = {
  bg: '#FFF8F3',
  card: '#FFFFFF',
  ink: '#332B2B',
  muted: '#8F7B75',
  coral: '#E96B61',
  coralSoft: '#FFE4DC',
  teal: '#16A89A',
  tealSoft: '#DDF5F0',
  blue: '#4898D1',
  red: '#C9535B',
  line: '#EEDDD6',
};

const hourOptions = Array.from({ length: 24 }, (_, hour) => hour.toString().padStart(2, '0'));
const minuteOptions = Array.from({ length: 60 }, (_, minute) => minute.toString().padStart(2, '0'));
const WHEEL_ITEM_HEIGHT = 44;
const intervalOptions = [1, 2, 3, 4, 6, 8, 12, 24].map((hours) => ({ value: String(hours), label: `每 ${hours} 小时` }));
const APP_PACKAGE = 'com.sindreyang.sindreeatyo';

type AlarmStatus = { exactAlarm: boolean; fullScreen: boolean; notifications: boolean; batteryOptimizationIgnored?: boolean; lastAlarmEvent?: string; lastAlarmAt?: string; recentAlarmEvents?: string; backgroundServiceEnabled?: boolean; backgroundServiceRunning?: boolean };

async function openAlarmPermissionSettings(status: AlarmStatus | null) {
  if (Platform.OS !== 'android') return;
  try {
    if (!status?.exactAlarm) {
      await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM, { data: `package:${APP_PACKAGE}` });
      return;
    }
  } catch {
    // Some Android versions do not expose the exact-alarm settings page.
  }
  try {
    if (!status?.fullScreen) {
      await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_APP_USE_FULL_SCREEN_INTENT, { data: `package:${APP_PACKAGE}` });
      return;
    }
  } catch {
    // Android versions without the full-screen permission page still use the lock-screen channel.
  }
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.APP_NOTIFICATION_SETTINGS, { data: `package:${APP_PACKAGE}` });
  } catch {
    // The system notification page is optional on old Android versions.
  }
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function recoverMissedDoses(data: AppData): AppData {
  const now = new Date();
  const start = data.lastCheckedAt ? new Date(data.lastCheckedAt) : now;
  if (!Number.isFinite(start.getTime()) || start >= now) return { ...data, lastCheckedAt: now.toISOString() };
  const pendingDoses = [...data.pendingDoses];
  const hasDose = (itemId: string, dueAt: string) => pendingDoses.some((dose) => dose.itemId === itemId && dose.dueAt === dueAt);
  const addDose = (item: YoItem, dueAt: Date) => {
    const dueAtIso = dueAt.toISOString();
    if (!hasDose(item.id, dueAtIso)) pendingDoses.push({ id: makeId('missed-dose'), itemId: item.id, dueAt: dueAtIso, status: 'pending' });
  };

  for (const item of data.items.filter((candidate) => candidate.enabled && candidate.name.trim())) {
    if (item.mode === 'interval') {
      const seconds = Math.max(15 * 60, item.intervalHours * 60 * 60);
      let due = new Date(new Date(item.createdAt).getTime() + seconds * 1000);
      while (due <= now) {
        if (due > start) addDose(item, due);
        due = new Date(due.getTime() + seconds * 1000);
        if (pendingDoses.filter((dose) => dose.itemId === item.id).length > 30) break;
      }
      continue;
    }

    const cursor = new Date(start);
    cursor.setHours(0, 0, 0, 0);
    while (cursor <= now) {
      const weekday = cursor.getDay() + 1;
      const appliesToday = item.repeatRule === 'daily' || item.weekdays.includes(weekday);
      if (appliesToday) {
        for (const time of item.fixedTimes) {
          const [hour, minute] = time.split(':').map(Number);
          if (!Number.isFinite(hour) || !Number.isFinite(minute)) continue;
          const due = new Date(cursor);
          due.setHours(hour, minute, 0, 0);
          if (due > start && due <= now) addDose(item, due);
        }
      }
      cursor.setDate(cursor.getDate() + 1);
    }
  }
  return { ...data, pendingDoses, lastCheckedAt: now.toISOString() };
}

export default function App() {
  return <SafeAreaProvider><AppContent /></SafeAreaProvider>;
}

function AppContent() {
  const [tab, setTab] = useState<Tab>('today');
  const [data, setData] = useState<AppData>({ items: [], pendingDoses: [] });
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState<YoItem | null>(null);
  const [notificationGranted, setNotificationGranted] = useState(false);
  const [alarmStatus, setAlarmStatus] = useState<AlarmStatus | null>(null);

  useEffect(() => {
    let mounted = true;
    let hydrated = false;
    const load = async () => {
      const stored = await loadData();
      const nativeConfirmed = await consumeConfirmedDoses();
      const confirmedKeys = new Set(nativeConfirmed.map((entry) => `${entry.itemId}|${entry.dueAt}`));
      const recovered = recoverMissedDoses(stored);
      const synced = {
        ...recovered,
        pendingDoses: recovered.pendingDoses.map((dose) => confirmedKeys.has(`${dose.itemId}|${dose.dueAt}`)
          ? { ...dose, status: 'confirmed' as const, confirmedAt: nativeConfirmed.find((entry) => entry.itemId === dose.itemId && entry.dueAt === dose.dueAt)?.confirmedAt ?? new Date().toISOString() }
          : dose),
      };
      const granted = await prepareNotifications();
      if (!mounted) return;
      setData(synced);
      await saveData(synced);
      setNotificationGranted(granted);
      setAlarmStatus(await getNativeAlarmStatus());
      await addDebugLog('app_ready', { notificationGranted: granted, itemCount: synced.items.length, pendingCount: synced.pendingDoses.filter((dose) => dose.status === 'pending').length });
      setReady(true);
      await rescheduleAll(synced.items);
      hydrated = true;
    };
    void load();

    const syncNativeConfirmations = async () => {
      if (!hydrated) return;
      const confirmed = await consumeConfirmedDoses();
      if (!confirmed.length) return;
      setData((previous) => {
        let changed = false;
        const next = {
          ...previous,
          pendingDoses: previous.pendingDoses.map((dose) => {
            const match = confirmed.find((entry) => entry.itemId === dose.itemId && entry.dueAt === dose.dueAt);
            if (!match || dose.status === 'confirmed') return dose;
            changed = true;
            return { ...dose, status: 'confirmed' as const, confirmedAt: match.confirmedAt ?? new Date().toISOString() };
          }),
          lastCheckedAt: new Date().toISOString(),
        };
        if (changed) void saveData(next);
        return changed ? next : previous;
      });
    };

    const addPendingFromNotification = (notification: Notifications.Notification) => {
      const itemId = String(notification.request.content.data?.itemId ?? '');
      if (!itemId) return;
      const dueAt = new Date(notification.date).toISOString();
      setData((previous) => {
        if (previous.pendingDoses.some((dose) => dose.itemId === itemId && dose.dueAt === dueAt)) return previous;
        const next = {
          ...previous,
          pendingDoses: [...previous.pendingDoses, { id: makeId('dose'), itemId, dueAt, status: 'pending' as const }],
          lastCheckedAt: new Date().toISOString(),
        };
        void saveData(next);
        return next;
      });
    };
    const received = Notifications.addNotificationReceivedListener(addPendingFromNotification);
    const response = Notifications.addNotificationResponseReceivedListener((event) => addPendingFromNotification(event.notification));
    void Notifications.getPresentedNotificationsAsync().then((presented) => presented.forEach((notification) => addPendingFromNotification(notification)));
    const confirmationPoll = setInterval(() => { void syncNativeConfirmations(); }, 2000);
    const appState = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void getNativeAlarmStatus().then(setAlarmStatus);
        void syncNativeConfirmations();
      }
      setData((previous) => {
        const next = state === 'active' ? recoverMissedDoses(previous) : { ...previous, lastCheckedAt: new Date().toISOString() };
        void saveData(next);
        return next;
      });
    });
    return () => {
      mounted = false;
      received.remove();
      response.remove();
      clearInterval(confirmationPoll);
      appState.remove();
    };
  }, []);

  const updateData = async (next: AppData) => {
    const stamped = { ...next, lastCheckedAt: new Date().toISOString() };
    setData(stamped);
    await saveData(stamped);
    await rescheduleAll(stamped.items);
  };

  const pending = useMemo(() => data.pendingDoses.filter((dose) => dose.status === 'pending'), [data.pendingDoses]);
  const itemById = (id: string) => data.items.find((item) => item.id === id);

  const confirmDose = async (dose: PendingDose) => {
    await updateData({ ...data, pendingDoses: data.pendingDoses.map((candidate) => candidate.id === dose.id ? { ...candidate, status: 'confirmed', confirmedAt: new Date().toISOString() } : candidate) });
    try {
      await stopAlarm(dose.itemId, dose.dueAt);
    } catch (error) {
      await addDebugLog('alarm_stop_failed', { error: error instanceof Error ? error.message : String(error) }, 'error');
    }
  };

  const saveItem = async (draft: YoItem) => {
    const isFirstItem = data.items.length === 0;
    const normalized = { ...draft, sound: draft.sound ?? 'default' as const };
    const nextItems = data.items.some((item) => item.id === normalized.id)
      ? data.items.map((item) => item.id === normalized.id ? normalized : item)
      : [...data.items, { ...normalized, id: makeId('medicine'), createdAt: new Date().toISOString() }];
    await updateData({ ...data, items: nextItems });
    setEditing(null);
    if (isFirstItem && Platform.OS === 'android' && alarmStatus && (!alarmStatus.exactAlarm || !alarmStatus.fullScreen)) {
      Alert.alert('开启闹钟级提醒', '为了在锁屏、息屏甚至省电模式下准时响铃，请开启精确闹钟和全屏提醒权限。', [
        { text: '稍后设置', style: 'cancel' },
        { text: '现在开启', onPress: () => void openAlarmPermissionSettings(alarmStatus) },
      ]);
    }
  };

  const deleteItem = (item: YoItem) => {
    Alert.alert('删除药品', `确定删除“${item.name}”吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void updateData({ ...data, items: data.items.filter((candidate) => candidate.id !== item.id), pendingDoses: data.pendingDoses.filter((dose) => dose.itemId !== item.id) }) },
    ]);
  };

  const refreshAlarmStatus = async () => {
    const next = await getNativeAlarmStatus();
    if (next) setAlarmStatus(next);
    return next;
  };

  if (!ready) {
    return <SafeAreaView style={styles.loading}><Image source={require('./assets/icon.png')} style={styles.loadingIcon} /><Text style={styles.logo}>吃哟咯</Text><Text style={styles.muted}>正在准备提醒…</Text></SafeAreaView>;
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="dark" />
      <View style={styles.header}>
        <View style={styles.brandRow}><Image source={require('./assets/icon.png')} style={styles.brandIcon} /><View><Text style={styles.logo}>吃哟咯</Text><Text style={styles.subtitle}>按时吃药，安心生活</Text></View></View>
        <View style={styles.headerBadge}><Text style={styles.headerBadgeText}>药</Text></View>
      </View>
      <View style={styles.content}>
        {tab === 'today' && <TodayScreen pending={pending} hasItems={data.items.length > 0} itemById={itemById} onConfirm={confirmDose} onAdd={() => setEditing(emptyItem())} />}
        {tab === 'items' && <ItemsScreen items={data.items} onEdit={setEditing} onDelete={deleteItem} onAdd={() => setEditing(emptyItem())} />}
        {tab === 'settings' && <SettingsScreen notificationGranted={notificationGranted} alarmStatus={alarmStatus} onRequest={async () => { setNotificationGranted(await prepareNotifications()); await refreshAlarmStatus(); }} onOpenAlarm={() => void openAlarmPermissionSettings(alarmStatus)} onOpenBackground={() => void openBatteryOptimizationSettings().then(() => refreshAlarmStatus())} onToggleBackground={(enabled) => void setBackgroundServiceEnabled(enabled).then(() => refreshAlarmStatus()).catch(() => Alert.alert('后台提醒未开启', '请允许吃哟咯显示通知并允许后台运行。'))} onTest={() => void testAlarm().then(() => addDebugLog('test_alarm_requested')).catch(() => Alert.alert('测试失败', '请先检查通知权限，并导出调试日志。'))} onExport={() => void exportDebugLog()} />}
      </View>
      <View style={styles.tabs}>
        <TabButton icon="⌂" label="今日" active={tab === 'today'} onPress={() => setTab('today')} />
        <TabButton icon="＋" label="药品" active={tab === 'items'} onPress={() => setTab('items')} />
        <TabButton icon="⚙" label="设置" active={tab === 'settings'} onPress={() => setTab('settings')} />
      </View>
      <ItemEditor item={editing} onClose={() => setEditing(null)} onSave={saveItem} />
    </SafeAreaView>
  );
}

function TodayScreen({ pending, hasItems, itemById, onConfirm, onAdd }: { pending: PendingDose[]; hasItems: boolean; itemById: (id: string) => YoItem | undefined; onConfirm: (dose: PendingDose) => void; onAdd: () => void }) {
  return <ScrollView contentContainerStyle={styles.scroll}>
    <View style={styles.dateRow}><View><Text style={styles.greeting}>今天也要按时吃药</Text><Text style={styles.date}>{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</Text></View><Text style={styles.sun}>✦</Text></View>
    <View style={[styles.summary, pending.length === 0 && styles.summaryDone]}><View style={styles.summaryIcon}><Text style={styles.summaryGlyph}>药</Text></View><Text style={styles.summaryNumber}>{pending.length}</Text><View><Text style={styles.summaryTitle}>{pending.length ? '项待确认' : '今天已完成'}</Text><Text style={styles.summarySub}>{pending.length ? '确认后才算完成' : '接下来按计划提醒'}</Text></View></View>
    <Text style={styles.sectionTitle}>{pending.length ? '现在需要确认' : '今日状态'}</Text>
    {pending.length === 0 ? <TodayEmptyState hasItems={hasItems} onAdd={onAdd} /> : pending.map((dose) => {
      const item = itemById(dose.itemId);
      if (!item) return null;
      return <View style={styles.doseCard} key={dose.id}><View style={styles.doseTop}><View style={styles.doseIcon}><Text style={styles.doseGlyph}>药</Text></View><View style={styles.doseInfo}><Text style={styles.doseName}>{item.name}</Text><Text style={styles.doseNote}>{item.note || '按医生要求服用'}</Text><Text style={styles.doseTime}>{formatTime(new Date(dose.dueAt))} · 等待确认</Text></View></View><Pressable accessibilityRole="button" accessibilityLabel={`确认${item.name}已吃药`} style={styles.confirmButton} onPress={() => onConfirm(dose)}><Text style={styles.confirmText}>确认已吃药</Text></Pressable></View>;
    })}
    {pending.length > 0 && <View style={styles.tip}><Text style={styles.tipIcon}>i</Text><Text style={styles.tipText}>提醒被划掉也没关系，未确认的药品会一直留在这里。</Text></View>}
  </ScrollView>;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return <View style={styles.empty}><Text style={styles.emptyGlyph}>药</Text><Text style={styles.emptyTitle}>还没有药品提醒</Text><Text style={styles.muted}>添加药品并设置提醒，时间到了我会叫你</Text><Pressable accessibilityRole="button" style={styles.primaryButton} onPress={onAdd}><Text style={styles.primaryText}>添加药品</Text></Pressable></View>;
}

function TodayEmptyState({ hasItems, onAdd }: { hasItems: boolean; onAdd: () => void }) {
  if (hasItems) {
    return <View style={styles.empty}><Text style={styles.emptyGlyph}>✓</Text><Text style={styles.emptyTitle}>今天暂时没有待确认药品</Text><Text style={styles.muted}>提醒会按计划继续执行，有新的提醒会显示在这里。</Text></View>;
  }
  return <EmptyState onAdd={onAdd} />;
}

function ItemsScreen({ items, onEdit, onDelete, onAdd }: { items: YoItem[]; onEdit: (item: YoItem) => void; onDelete: (item: YoItem) => void; onAdd: () => void }) {
  return <View style={styles.screen}>
    <View style={styles.toolbar}><Text style={styles.sectionTitle}>我的药品</Text><Pressable accessibilityRole="button" style={styles.addMedicineButton} onPress={onAdd}><Text style={styles.addMedicineText}>＋ 添加药品</Text></Pressable></View>
    <FlatList data={items} keyExtractor={(item) => item.id} contentContainerStyle={styles.list} ListEmptyComponent={<EmptyState onAdd={onAdd} />} renderItem={({ item }) => <View style={styles.itemCard}><View style={[styles.itemIcon, !item.enabled && { backgroundColor: '#EEE' }]}><Text style={styles.itemGlyph}>药</Text></View><Pressable accessibilityRole="button" style={styles.itemMain} onPress={() => onEdit(item)}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.itemNote}>{item.note || '未填写备注'}</Text><Text style={styles.itemRule}>{item.mode === 'interval' ? `每 ${item.intervalHours} 小时` : item.fixedTimes.join('、')}</Text></Pressable><View style={styles.itemRight}><Text style={styles.bell}>响铃</Text><View style={styles.itemActions}><Pressable accessibilityRole="button" style={styles.itemActionButton} onPress={() => onEdit(item)}><Text style={styles.editText}>修改</Text></Pressable><Pressable accessibilityRole="button" style={styles.itemActionButton} onPress={() => onDelete(item)}><Text style={styles.delete}>删除</Text></Pressable></View></View></View>} />
  </View>;
}

function SettingsScreen({ notificationGranted, alarmStatus, onRequest, onOpenAlarm, onOpenBackground, onToggleBackground, onTest, onExport }: { notificationGranted: boolean; alarmStatus: AlarmStatus | null; onRequest: () => void; onOpenAlarm: () => void; onOpenBackground: () => void; onToggleBackground: (enabled: boolean) => void; onTest: () => void; onExport: () => void }) {
  const alarmReady = Boolean(alarmStatus?.exactAlarm && alarmStatus?.fullScreen);
  const backgroundReady = alarmStatus?.batteryOptimizationIgnored === true;
  const backgroundEnabled = alarmStatus?.backgroundServiceEnabled === true;
  return <ScrollView contentContainerStyle={styles.scroll}><Text style={styles.sectionTitle}>设置</Text><View style={styles.settingCard}><Text style={styles.settingTitle}>提醒权限</Text><Text style={styles.settingSub}>{notificationGranted ? '通知已允许，时间到了会提醒你' : '还没有允许通知，提醒可能不会响'}</Text><View style={styles.statusRow}><Text style={styles.statusDot}>{notificationGranted ? '●' : '○'}</Text><Text style={styles.statusText}>{notificationGranted ? '通知提醒已开启' : '需要开启通知提醒'}</Text></View><Pressable style={styles.secondaryButton} onPress={onRequest}><Text style={styles.secondaryText}>{notificationGranted ? '检查通知设置' : '开启通知权限'}</Text></Pressable><View style={styles.permissionDivider} /><Text style={styles.settingTitle}>锁屏闹钟提醒</Text><Text style={styles.settingSub}>{alarmReady ? '已准备好，锁屏和息屏时也会响铃、振动' : '还需要开启系统权限，才能尽量按时响铃'}</Text><View style={styles.statusRow}><Text style={styles.statusDot}>{alarmReady ? '●' : '○'}</Text><Text style={[styles.statusText, alarmReady && styles.statusReady]}>{alarmReady ? '锁屏闹钟已开启' : '锁屏闹钟未完成'}</Text></View>{!alarmReady && <Pressable style={styles.alarmPermissionButton} onPress={onOpenAlarm}><Text style={styles.alarmPermissionText}>去开启闹钟权限</Text></Pressable>}<Pressable style={styles.testButton} onPress={onTest}><Text style={styles.testButtonText}>立即测试响铃和振动</Text></Pressable></View><View style={styles.settingCard}><Text style={styles.settingTitle}>后台提醒</Text><Text style={styles.settingSub}>{backgroundEnabled ? '已打开，退出吃哟咯后仍会等待提醒' : '未打开，建议打开后再关闭 App'}</Text><View style={styles.switchRow}><View style={styles.switchCopy}><Text style={styles.statusText}>{backgroundEnabled ? '后台提醒已开启' : '后台提醒已关闭'}</Text><Text style={styles.helper}>系统会保留一条后台通知，帮助到点响铃不被清理。</Text></View><Switch value={backgroundEnabled} onValueChange={onToggleBackground} trackColor={{ true: colors.teal }} thumbColor="#FFF" /></View><View style={styles.statusRow}><Text style={styles.statusDot}>{backgroundReady ? '●' : '○'}</Text><Text style={[styles.statusText, backgroundReady && styles.statusReady]}>{backgroundReady ? '电池优化已放行' : '还需允许后台运行'}</Text></View><Pressable style={styles.secondaryButton} onPress={onOpenBackground}><Text style={styles.secondaryText}>{backgroundReady ? '检查后台设置' : '允许后台运行'}</Text></Pressable><Text style={styles.permissionHint}>如果手机还有“自启动”“后台耗电”设置，请允许吃哟咯自启动并设为“不限制”。</Text></View><View style={styles.settingCard}><Text style={styles.settingTitle}>导出调试日志</Text><Text style={styles.settingSub}>遇到没有响铃、没有通知或权限显示不对时，导出后发给我。日志不包含药品名称和备注。</Text><Pressable style={styles.secondaryButton} onPress={onExport}><Text style={styles.secondaryText}>导出调试日志</Text></Pressable></View><View style={styles.settingCard}><Text style={styles.settingTitle}>关于吃哟咯</Text><Text style={styles.settingSub}>通知被划掉或错过后，未确认的药品仍会留在“今日”，直到你确认已吃药。</Text></View></ScrollView>;
}

function TabButton({ icon, label, active, onPress }: { icon: string; label: string; active: boolean; onPress: () => void }) { return <Pressable style={styles.tab} onPress={onPress}><Text style={[styles.tabIcon, active && styles.tabActive]}>{icon}</Text><Text style={[styles.tabLabel, active && styles.tabActive]}>{label}</Text></Pressable>; }

function OptionPicker({ visible, title, options, value, onSelect, onClose }: { visible: boolean; title: string; options: Array<{ value: string; label: string }>; value: string; onSelect: (value: string) => void; onClose: () => void }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><Pressable style={styles.pickerBackdrop} onPress={onClose}><Pressable style={styles.pickerSheet} onPress={(event) => event.stopPropagation()}><View style={styles.pickerHeader}><Text style={styles.pickerTitle}>{title}</Text><Pressable onPress={onClose}><Text style={styles.link}>关闭</Text></Pressable></View><FlatList data={options} keyExtractor={(option) => option.value} style={styles.pickerList} renderItem={({ item: option }) => <Pressable style={[styles.pickerOption, option.value === value && styles.pickerOptionOn]} onPress={() => { onSelect(option.value); onClose(); }}><Text style={[styles.pickerOptionText, option.value === value && styles.pickerOptionTextOn]}>{option.label}</Text>{option.value === value && <Text style={styles.check}>✓</Text>}</Pressable>} /></Pressable></Pressable></Modal>;
}

function TimeWheelPicker({ visible, value, onSelect, onClose }: { visible: boolean; value: string; onSelect: (value: string) => void; onClose: () => void }) {
  const [rawHour, rawMinute] = value.split(':');
  const initialHour = hourOptions.includes(rawHour) ? rawHour : '08';
  const initialMinute = minuteOptions.includes(rawMinute) ? rawMinute : '00';
  const [hour, setHour] = useState(initialHour);
  const [minute, setMinute] = useState(initialMinute);

  useEffect(() => {
    if (visible) {
      setHour(initialHour);
      setMinute(initialMinute);
    }
  }, [visible, initialHour, initialMinute]);

  const finish = () => {
    onSelect(`${hour}:${minute}`);
    onClose();
  };
  const onWheelEnd = (values: string[], setValue: (value: string) => void) => (event: { nativeEvent: { contentOffset: { y: number } } }) => {
    const index = Math.max(0, Math.min(values.length - 1, Math.round(event.nativeEvent.contentOffset.y / WHEEL_ITEM_HEIGHT)));
    setValue(values[index]);
  };
  const renderWheel = (values: string[], selected: string, setValue: (value: string) => void, key: string) => (
    <ScrollView
      key={`${visible}-${key}-${initialHour}-${initialMinute}`}
      style={styles.wheelList}
      contentContainerStyle={styles.wheelContent}
      showsVerticalScrollIndicator={false}
      snapToInterval={WHEEL_ITEM_HEIGHT}
      decelerationRate="fast"
      nestedScrollEnabled
      scrollEnabled
      contentOffset={{ x: 0, y: Math.max(0, values.indexOf(selected)) * WHEEL_ITEM_HEIGHT }}
      onMomentumScrollEnd={onWheelEnd(values, setValue)}
      onScrollEndDrag={onWheelEnd(values, setValue)}
    >
      {values.map((entry) => <View style={[styles.wheelItem, entry === selected && styles.wheelItemOn]} key={`${key}-${entry}`}><Text style={[styles.wheelItemText, entry === selected && styles.wheelItemTextOn]}>{entry}</Text></View>)}
    </ScrollView>
  );

  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
    <View style={styles.pickerBackdrop}>
      <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={styles.pickerSheet}>
        <View style={styles.pickerHeader}><Text style={styles.pickerTitle}>选择吃药时间</Text><Pressable hitSlop={8} onPress={finish}><Text style={styles.link}>完成</Text></Pressable></View>
        <View style={styles.wheelRow}>
          <View style={styles.wheelColumn}>{renderWheel(hourOptions, hour, setHour, 'hour')}<Text style={styles.wheelUnit}>时</Text></View>
          <View style={styles.wheelColumn}>{renderWheel(minuteOptions, minute, setMinute, 'minute')}<Text style={styles.wheelUnit}>分</Text></View>
        </View>
      </View>
    </View>
  </Modal>;
}

function SelectField({ label, value, onPress }: { label?: string; value: string; onPress: () => void }) {
  return <View>{label && <Text style={styles.helper}>{label}</Text>}<Pressable style={styles.selectField} onPress={onPress}><Text style={styles.selectText}>{value}</Text><Text style={styles.chevron}>⌄</Text></Pressable></View>;
}

function ItemEditor({ item, onClose, onSave }: { item: YoItem | null; onClose: () => void; onSave: (item: YoItem) => void }) {
  const [draft, setDraft] = useState<YoItem>(emptyItem());
  const [picker, setPicker] = useState<PickerKind>(null);
  const [editingTimeIndex, setEditingTimeIndex] = useState(0);
  useEffect(() => { if (item) setDraft({ ...emptyItem(), ...item, sound: item.sound ?? 'default' }); }, [item]);
  if (!item) return null;
  const set = <K extends keyof YoItem>(key: K, value: YoItem[K]) => setDraft((old) => ({ ...old, [key]: value }));
  const save = () => {
    if (!draft.name.trim()) return Alert.alert('还差一步', '请先填写药品名称');
    if (draft.mode === 'fixed' && draft.fixedTimes.length === 0) return Alert.alert('还差一步', '至少保留一个提醒时间');
    if (draft.repeatRule !== 'daily' && draft.weekdays.length === 0) return Alert.alert('还差一步', '至少选择一天提醒');
    onSave(draft);
  };
  const days: Array<[string, number]> = [['日', 1], ['一', 2], ['二', 3], ['三', 4], ['四', 5], ['五', 6], ['六', 7]];
  const selectedTime = draft.fixedTimes[editingTimeIndex] ?? '08:00';

  return <Modal visible={Boolean(item)} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
    <SafeAreaView style={styles.modalSafe} edges={['top', 'bottom']}>
    <KeyboardAvoidingView style={styles.modal} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <View style={styles.modalHeader}><Pressable hitSlop={10} onPress={onClose}><Text style={styles.link}>取消</Text></Pressable><Text style={styles.modalTitle}>{draft.id ? '编辑药品' : '添加药品'}</Text><View style={styles.headerSpacer} /></View>
      <ScrollView style={styles.formScroll} contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <Text style={styles.formIntro}>把每次吃药安排好，时间到了我会提醒你。</Text>
        <Text style={styles.label}>药品名称</Text><TextInput value={draft.name} onChangeText={(value) => set('name', value)} placeholder="例如：优思明" placeholderTextColor={colors.muted} style={styles.input} autoFocus={!draft.id} />
        <Text style={styles.label}>备注</Text><TextInput value={draft.note} onChangeText={(value) => set('note', value)} placeholder="例如：早晚各 1 片" placeholderTextColor={colors.muted} style={[styles.input, styles.textarea]} multiline />
        <Text style={styles.label}>提醒方式</Text><View style={styles.segment}><Segment label="按间隔" active={draft.mode === 'interval'} onPress={() => set('mode', 'interval')} /><Segment label="固定时间" active={draft.mode === 'fixed'} onPress={() => set('mode', 'fixed')} /></View>
        {draft.mode === 'interval' ? <View style={styles.controlBlock}><SelectField label="多久提醒一次" value={`每 ${draft.intervalHours} 小时`} onPress={() => setPicker('interval')} /></View> : <View style={styles.controlBlock}><Text style={styles.helper}>每天提醒时间</Text>{draft.fixedTimes.map((time, index) => <View style={styles.timeRow} key={`${index}-${time}`}><View style={styles.timeFieldWrap}><SelectField value={time} onPress={() => { setEditingTimeIndex(index); setPicker('time'); }} /></View><Pressable hitSlop={8} onPress={() => set('fixedTimes', draft.fixedTimes.filter((_, i) => i !== index))}><Text style={styles.delete}>移除</Text></Pressable></View>)}<Pressable style={styles.addTimeButton} onPress={() => set('fixedTimes', [...draft.fixedTimes, '20:00'])}><Text style={styles.link}>＋ 添加一个时间</Text></Pressable></View>}
        <Text style={styles.label}>重复</Text><View style={styles.segment}><Segment label="每天" active={draft.repeatRule === 'daily'} onPress={() => set('repeatRule', 'daily')} /><Segment label="每周" active={draft.repeatRule === 'weekly'} onPress={() => { set('repeatRule', 'weekly'); set('weekdays', [2]); }} /><Segment label="自定义" active={draft.repeatRule === 'custom'} onPress={() => { set('repeatRule', 'custom'); set('weekdays', [1, 2, 3, 4, 5, 6, 7]); }} /></View>
        {draft.repeatRule !== 'daily' && <View style={styles.controlBlock}><Text style={styles.helper}>选择提醒日</Text><View style={styles.weekdays}>{days.map(([label, day]) => { const selected = draft.weekdays.includes(day); return <Pressable key={day} onPress={() => { const next = draft.repeatRule === 'weekly' ? [day] : selected ? draft.weekdays.filter((value) => value !== day) : [...draft.weekdays, day]; set('weekdays', next); }} style={[styles.weekday, selected && styles.weekdayOn]}><Text style={[styles.weekdayText, selected && styles.weekdayTextOn]}>{label}</Text></Pressable>; })}</View></View>}
        <Text style={styles.helper}>响铃使用手机当前的系统闹钟声，并会振动</Text>
        <View style={styles.switchRow}><View style={styles.switchCopy}><Text style={styles.label}>启用提醒</Text><Text style={styles.helper}>未确认时每分钟提醒一次，确认后停止</Text></View><Switch value={draft.enabled} onValueChange={(value) => { if (value) { set('enabled', true); return; } Alert.alert('关闭提醒？', '关闭后这个药品不会再响铃和振动。', [{ text: '继续开启', style: 'cancel' }, { text: '确认关闭', style: 'destructive', onPress: () => set('enabled', false) }]); }} trackColor={{ true: colors.teal }} thumbColor="#FFF" /></View>
      </ScrollView>
      <View style={styles.modalFooter}><Pressable style={styles.saveButton} onPress={save}><Text style={styles.saveButtonText}>保存提醒</Text></Pressable></View>
      <OptionPicker visible={picker === 'interval'} title="选择提醒间隔" options={intervalOptions} value={String(draft.intervalHours)} onSelect={(value) => set('intervalHours', Number(value))} onClose={() => setPicker(null)} />
      <TimeWheelPicker visible={picker === 'time'} value={selectedTime} onSelect={(value) => set('fixedTimes', draft.fixedTimes.map((time, index) => index === editingTimeIndex ? value : time))} onClose={() => setPicker(null)} />
    </KeyboardAvoidingView>
    </SafeAreaView>
  </Modal>;
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.segmentButton, active && styles.segmentActive]}><Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg }, modalSafe: { flex: 1, backgroundColor: colors.bg }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }, loadingIcon: { width: 78, height: 78, borderRadius: 22, marginBottom: 12 }, content: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, brandRow: { flexDirection: 'row', alignItems: 'center' }, brandIcon: { width: 42, height: 42, borderRadius: 13, marginRight: 10 }, logo: { color: colors.ink, fontSize: 27, fontWeight: '800', letterSpacing: 1 }, subtitle: { color: colors.muted, fontSize: 12, marginTop: 2 }, headerBadge: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.tealSoft, alignItems: 'center', justifyContent: 'center' }, headerBadgeText: { color: colors.teal, fontSize: 20, fontWeight: '800' },
  scroll: { padding: 20, paddingBottom: 35 }, screen: { flex: 1, paddingHorizontal: 20 }, dateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }, greeting: { color: colors.ink, fontSize: 21, fontWeight: '800' }, date: { color: colors.muted, marginTop: 5 }, sun: { color: colors.coral, fontSize: 32 }, summary: { backgroundColor: colors.coral, borderRadius: 22, padding: 17, flexDirection: 'row', alignItems: 'center', marginBottom: 24 }, summaryDone: { backgroundColor: colors.teal }, summaryIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#FFF1EC', alignItems: 'center', justifyContent: 'center', marginRight: 12 }, summaryGlyph: { color: colors.coral, fontSize: 16, fontWeight: '800' }, summaryNumber: { color: '#FFF', fontSize: 38, fontWeight: '800', marginRight: 12 }, summaryTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' }, summarySub: { color: '#FFF6F2', marginTop: 4 }, sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '800', marginBottom: 12 },
  doseCard: { backgroundColor: colors.card, borderRadius: 20, padding: 14, marginBottom: 12, shadowColor: '#D6B9AB', shadowOpacity: 0.12, shadowRadius: 9, elevation: 2 }, doseTop: { flexDirection: 'row', alignItems: 'center', marginBottom: 12 }, doseIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: colors.tealSoft, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, doseGlyph: { color: colors.teal, fontSize: 16, fontWeight: '800' }, doseInfo: { flex: 1 }, doseName: { color: colors.ink, fontSize: 17, fontWeight: '800' }, doseNote: { color: colors.muted, marginTop: 3 }, doseTime: { color: colors.red, fontSize: 12, marginTop: 6 }, confirmButton: { minHeight: 48, backgroundColor: colors.teal, borderRadius: 13, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 12 }, confirmText: { color: '#FFF', fontWeight: '800', fontSize: 15 }, tip: { flexDirection: 'row', padding: 14, backgroundColor: '#FFF0D9', borderRadius: 16, marginTop: 10 }, tipIcon: { width: 20, height: 20, borderRadius: 10, borderWidth: 1, borderColor: colors.coral, color: colors.coral, fontSize: 13, fontWeight: '800', textAlign: 'center', marginRight: 8 }, tipText: { color: '#886A4A', flex: 1, lineHeight: 19, fontSize: 12 }, empty: { alignItems: 'center', backgroundColor: colors.card, borderRadius: 22, padding: 28 }, emptyGlyph: { width: 52, height: 52, borderRadius: 18, backgroundColor: colors.tealSoft, color: colors.teal, fontSize: 20, fontWeight: '800', textAlign: 'center', textAlignVertical: 'center', marginBottom: 10 }, emptyTitle: { color: colors.ink, fontWeight: '800', fontSize: 17, marginBottom: 5 }, muted: { color: colors.muted }, primaryButton: { minHeight: 48, backgroundColor: colors.coral, paddingHorizontal: 22, borderRadius: 14, marginTop: 18, alignItems: 'center', justifyContent: 'center' }, primaryText: { color: '#FFF', fontWeight: '800' },
  tabs: { minHeight: 75, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 9 }, tab: { alignItems: 'center', justifyContent: 'center', flex: 1, minHeight: 58 }, tabIcon: { fontSize: 21, color: '#B8A59D' }, tabLabel: { color: '#B8A59D', fontSize: 12, marginTop: 3 }, tabActive: { color: colors.coral, fontWeight: '800' }, toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 16, paddingBottom: 5 }, link: { color: colors.coral, fontWeight: '800', minHeight: 44, textAlignVertical: 'center' }, addMedicineButton: { minHeight: 44, paddingHorizontal: 14, borderRadius: 13, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center' }, addMedicineText: { color: '#FFF', fontWeight: '800', fontSize: 14 }, list: { paddingVertical: 10, paddingBottom: 35 }, itemCard: { backgroundColor: colors.card, borderRadius: 18, padding: 12, marginBottom: 10, flexDirection: 'row', alignItems: 'center' }, itemIcon: { backgroundColor: colors.tealSoft, width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 10 }, itemGlyph: { color: colors.teal, fontSize: 16, fontWeight: '800' }, itemMain: { flex: 1, minHeight: 58, justifyContent: 'center' }, itemName: { color: colors.ink, fontSize: 16, fontWeight: '800' }, itemNote: { color: colors.muted, fontSize: 12, marginTop: 3 }, itemRule: { color: colors.coral, fontSize: 12, marginTop: 6 }, itemRight: { alignItems: 'flex-end', marginLeft: 5 }, bell: { color: colors.muted, fontSize: 11, marginBottom: 2 }, itemActions: { flexDirection: 'row', alignItems: 'center' }, itemActionButton: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }, editText: { color: colors.teal, fontSize: 12, fontWeight: '800' }, delete: { color: colors.red, fontSize: 12, fontWeight: '700' },
  settingCard: { backgroundColor: colors.card, borderRadius: 20, padding: 18, marginBottom: 12 }, settingTitle: { color: colors.ink, fontWeight: '800', fontSize: 16 }, settingSub: { color: colors.muted, lineHeight: 20, marginTop: 7 }, statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 12 }, statusDot: { color: colors.teal, fontSize: 17, marginRight: 7 }, statusText: { color: colors.ink, fontWeight: '700' }, statusReady: { color: colors.teal }, secondaryButton: { alignSelf: 'flex-start', minHeight: 44, borderWidth: 1, borderColor: colors.coral, borderRadius: 12, paddingHorizontal: 14, marginTop: 14, alignItems: 'center', justifyContent: 'center' }, secondaryText: { color: colors.coral, fontWeight: '800' }, permissionDivider: { height: 1, backgroundColor: colors.line, marginVertical: 18 }, alarmPermissionButton: { alignSelf: 'flex-start', minHeight: 44, borderWidth: 1, borderColor: colors.teal, borderRadius: 12, paddingHorizontal: 14, marginTop: 12, alignItems: 'center', justifyContent: 'center' }, alarmPermissionText: { color: colors.teal, fontWeight: '800' }, testButton: { alignSelf: 'flex-start', minHeight: 44, borderRadius: 12, paddingHorizontal: 14, marginTop: 10, backgroundColor: colors.coralSoft, alignItems: 'center', justifyContent: 'center' }, testButtonText: { color: colors.coral, fontWeight: '800' }, permissionHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
  modal: { flex: 1, backgroundColor: colors.bg }, modalHeader: { minHeight: 62, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFF' }, modalTitle: { color: colors.ink, fontWeight: '800', fontSize: 18 }, headerSpacer: { width: 36 }, formScroll: { flex: 1 }, form: { padding: 20, paddingBottom: 34 }, formIntro: { color: colors.muted, lineHeight: 20, marginBottom: 4 }, label: { color: colors.ink, fontWeight: '800', marginTop: 17, marginBottom: 8 }, helper: { color: colors.muted, fontSize: 12, marginBottom: 8 }, input: { backgroundColor: '#FFF', borderRadius: 14, borderWidth: 1, borderColor: colors.line, color: colors.ink, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 }, textarea: { minHeight: 74, textAlignVertical: 'top' }, controlBlock: { marginTop: 2 }, segment: { flexDirection: 'row', gap: 8 }, segmentButton: { flex: 1, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingVertical: 13, alignItems: 'center', backgroundColor: '#FFF' }, segmentActive: { backgroundColor: colors.coralSoft, borderColor: colors.coral }, segmentText: { color: colors.muted, fontWeight: '700' }, segmentTextActive: { color: colors.coral }, timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }, timeFieldWrap: { flex: 1 }, selectField: { minHeight: 49, backgroundColor: '#FFF', borderRadius: 14, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, selectText: { color: colors.ink, fontSize: 16, fontWeight: '600' }, chevron: { color: colors.coral, fontSize: 22, lineHeight: 22 }, addTimeButton: { paddingVertical: 10 }, weekdays: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }, weekday: { width: 37, height: 37, borderRadius: 19, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' }, weekdayOn: { backgroundColor: colors.coral, borderColor: colors.coral }, weekdayText: { color: colors.muted, fontWeight: '700' }, weekdayTextOn: { color: '#FFF' }, switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingBottom: 4 }, switchCopy: { flex: 1 }, modalFooter: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: Platform.OS === 'ios' ? 22 : 14, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: '#FFF' }, saveButton: { minHeight: 50, borderRadius: 15, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center' }, saveButtonText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(51,43,43,0.35)', justifyContent: 'flex-end' }, pickerSheet: { maxHeight: '78%', backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 16 }, pickerHeader: { paddingHorizontal: 20, paddingVertical: 16, backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pickerTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' }, pickerList: { paddingHorizontal: 14, paddingTop: 10 }, pickerOption: { minHeight: 48, paddingHorizontal: 16, borderRadius: 13, backgroundColor: '#FFF', marginBottom: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pickerOptionOn: { backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: colors.coral }, pickerOptionText: { color: colors.ink, fontSize: 16 }, pickerOptionTextOn: { color: colors.coral, fontWeight: '800' }, check: { color: colors.coral, fontSize: 20, fontWeight: '800' }, wheelRow: { flexDirection: 'row', justifyContent: 'center', paddingHorizontal: 30, paddingVertical: 12 }, wheelColumn: { width: 100, alignItems: 'center', marginHorizontal: 12 }, wheelList: { height: 220, width: 100 }, wheelContent: { paddingVertical: 88 }, wheelItem: { height: WHEEL_ITEM_HEIGHT, alignItems: 'center', justifyContent: 'center', borderRadius: 12 }, wheelItemOn: { backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: colors.coral }, wheelItemText: { color: colors.muted, fontSize: 20, fontWeight: '600' }, wheelItemTextOn: { color: colors.coral, fontSize: 24, fontWeight: '800' }, wheelUnit: { color: colors.ink, fontSize: 15, fontWeight: '800', marginTop: 4 },
});
