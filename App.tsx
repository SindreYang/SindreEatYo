import { StatusBar } from 'expo-status-bar';
import * as Notifications from 'expo-notifications';
import * as IntentLauncher from 'expo-intent-launcher';
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  FlatList,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { emptyItem, PendingDose, AppData, YoItem, ReminderSound } from './src/types';
import { loadData, saveData } from './src/storage';
import { notificationContent, prepareNotifications, rescheduleAll, soundLabels } from './src/notifications';

type Tab = 'today' | 'items' | 'settings';
type PickerKind = 'interval' | 'time' | 'delay' | 'sound' | null;

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

const timeOptions = Array.from({ length: 96 }, (_, index) => {
  const hour = Math.floor(index / 4).toString().padStart(2, '0');
  const minute = ((index % 4) * 15).toString().padStart(2, '0');
  return `${hour}:${minute}`;
});
const intervalOptions = [1, 2, 3, 4, 6, 8, 12, 24].map((hours) => ({ value: String(hours), label: `每 ${hours} 小时` }));
const delayOptions = [5, 10, 15, 30, 60].map((minutes) => ({ value: String(minutes), label: `间隔 ${minutes} 分钟` }));
const soundOptions = (Object.keys(soundLabels) as ReminderSound[]).map((value) => ({ value, label: soundLabels[value] }));
const APP_PACKAGE = 'com.sindreyang.sindreeatyo';

async function openAlarmPermissionSettings() {
  if (Platform.OS !== 'android') return;
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.REQUEST_SCHEDULE_EXACT_ALARM, { data: `package:${APP_PACKAGE}` });
  } catch {
    // Some Android versions do not expose the exact-alarm settings page.
  }
  try {
    await IntentLauncher.startActivityAsync(IntentLauncher.ActivityAction.MANAGE_APP_USE_FULL_SCREEN_INTENT, { data: `package:${APP_PACKAGE}` });
  } catch {
    // Android versions without the full-screen permission page still use the lock-screen channel.
  }
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(date = new Date()) {
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export default function App() {
  const [tab, setTab] = useState<Tab>('today');
  const [data, setData] = useState<AppData>({ items: [], pendingDoses: [] });
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState<YoItem | null>(null);
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [notificationGranted, setNotificationGranted] = useState(false);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      const stored = await loadData();
      const granted = await prepareNotifications();
      if (!mounted) return;
      setData(stored);
      setNotificationGranted(granted);
      setReady(true);
      await rescheduleAll(stored.items);
    };
    void load();

    const addPendingFromNotification = (notification: Notifications.Notification) => {
      const itemId = String(notification.request.content.data?.itemId ?? '');
      if (!itemId) return;
      setData((previous) => {
        if (previous.pendingDoses.some((dose) => dose.itemId === itemId && dose.status === 'pending')) return previous;
        const next = {
          ...previous,
          pendingDoses: [...previous.pendingDoses, { id: makeId('dose'), itemId, dueAt: new Date().toISOString(), status: 'pending' as const }],
        };
        void saveData(next);
        return next;
      });
    };
    const received = Notifications.addNotificationReceivedListener(addPendingFromNotification);
    const response = Notifications.addNotificationResponseReceivedListener((event) => addPendingFromNotification(event.notification));
    return () => {
      mounted = false;
      received.remove();
      response.remove();
    };
  }, []);

  const updateData = async (next: AppData) => {
    setData(next);
    await saveData(next);
    await rescheduleAll(next.items);
  };

  const pending = useMemo(() => data.pendingDoses.filter((dose) => dose.status === 'pending'), [data.pendingDoses]);
  const itemById = (id: string) => data.items.find((item) => item.id === id);

  const confirmDose = async (dose: PendingDose) => {
    await updateData({ ...data, pendingDoses: data.pendingDoses.map((candidate) => candidate.id === dose.id ? { ...candidate, status: 'confirmed', confirmedAt: new Date().toISOString() } : candidate) });
  };

  const snoozeDose = async (dose: PendingDose) => {
    const item = itemById(dose.itemId);
    if (!item) return;
    await updateData({ ...data, pendingDoses: data.pendingDoses.map((candidate) => candidate.id === dose.id ? { ...candidate, status: 'snoozed' } : candidate) });
    await Notifications.scheduleNotificationAsync({
      content: notificationContent(item),
      trigger: { type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL, seconds: 10 * 60, repeats: false } as Notifications.NotificationTriggerInput,
    });
  };

  const saveItem = async (draft: YoItem) => {
    const isFirstItem = data.items.length === 0;
    const normalized = { ...draft, sound: draft.sound ?? 'default' as const };
    const nextItems = data.items.some((item) => item.id === normalized.id)
      ? data.items.map((item) => item.id === normalized.id ? normalized : item)
      : [...data.items, { ...normalized, id: makeId('medicine'), createdAt: new Date().toISOString() }];
    await updateData({ ...data, items: nextItems });
    setEditing(null);
    if (isFirstItem && Platform.OS === 'android') {
      Alert.alert('开启闹钟级提醒', '为了在锁屏、息屏甚至省电模式下准时响铃，请开启精确闹钟和全屏提醒权限。', [
        { text: '稍后设置', style: 'cancel' },
        { text: '现在开启', onPress: () => void openAlarmPermissionSettings() },
      ]);
    }
  };

  const deleteItem = (item: YoItem) => {
    Alert.alert('删除药品', `确定删除“${item.name}”吗？`, [
      { text: '取消', style: 'cancel' },
      { text: '删除', style: 'destructive', onPress: () => void updateData({ ...data, items: data.items.filter((candidate) => candidate.id !== item.id) }) },
    ]);
  };

  const applyBatch = async (bellCount: 1 | 2) => {
    if (!selectedIds.length) return;
    await updateData({ ...data, items: data.items.map((item) => selectedIds.includes(item.id) ? { ...item, bellCount } : item) });
    setSelectedIds([]);
    setBatchMode(false);
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
        {tab === 'today' && <TodayScreen pending={pending} itemById={itemById} onConfirm={confirmDose} onSnooze={snoozeDose} onAdd={() => setEditing(emptyItem())} />}
        {tab === 'items' && <ItemsScreen items={data.items} batchMode={batchMode} selectedIds={selectedIds} onEdit={setEditing} onDelete={deleteItem} onAdd={() => setEditing(emptyItem())} onBatch={() => setBatchMode((value) => !value)} onToggle={(id) => setSelectedIds((ids) => ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id])} onApplyBatch={applyBatch} />}
        {tab === 'settings' && <SettingsScreen notificationGranted={notificationGranted} onRequest={async () => setNotificationGranted(await prepareNotifications())} />}
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

function TodayScreen({ pending, itemById, onConfirm, onSnooze, onAdd }: { pending: PendingDose[]; itemById: (id: string) => YoItem | undefined; onConfirm: (dose: PendingDose) => void; onSnooze: (dose: PendingDose) => void; onAdd: () => void }) {
  return <ScrollView contentContainerStyle={styles.scroll}>
    <View style={styles.dateRow}><View><Text style={styles.greeting}>今天也要按时吃药</Text><Text style={styles.date}>{new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'long' })}</Text></View><Text style={styles.sun}>✦</Text></View>
    <View style={styles.summary}><View style={styles.summaryIcon}><Text>💊</Text></View><Text style={styles.summaryNumber}>{pending.length}</Text><View><Text style={styles.summaryTitle}>项待确认</Text><Text style={styles.summarySub}>{pending.length ? '确认后才算完成哦' : '今天目前都完成啦'}</Text></View></View>
    <Text style={styles.sectionTitle}>待确认</Text>
    {pending.length === 0 ? <EmptyState onAdd={onAdd} /> : pending.map((dose) => {
      const item = itemById(dose.itemId);
      if (!item) return null;
      return <View style={styles.doseCard} key={dose.id}><View style={styles.doseIcon}><Text>💊</Text></View><View style={styles.doseInfo}><Text style={styles.doseName}>{item.name}</Text><Text style={styles.doseNote}>{item.note || '没有备注'}</Text><Text style={styles.doseTime}>{formatTime(new Date(dose.dueAt))} · 等待确认</Text></View><View style={styles.doseActions}><Pressable style={styles.confirmButton} onPress={() => onConfirm(dose)}><Text style={styles.confirmText}>确认已吃药</Text></Pressable><Pressable onPress={() => onSnooze(dose)}><Text style={styles.snooze}>稍后 10 分钟</Text></Pressable></View></View>;
    })}
    <View style={styles.tip}><Text style={styles.tipIcon}>ⓘ</Text><Text style={styles.tipText}>提醒可以被系统暂时划掉，但未确认状态会一直保留在这里。</Text></View>
  </ScrollView>;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return <View style={styles.empty}><Text style={styles.emptyEmoji}>💊</Text><Text style={styles.emptyTitle}>现在没有待确认药品</Text><Text style={styles.muted}>添加药品并设置提醒，时间到了我会叫你</Text><Pressable style={styles.primaryButton} onPress={onAdd}><Text style={styles.primaryText}>添加药品</Text></Pressable></View>;
}

function ItemsScreen({ items, batchMode, selectedIds, onEdit, onDelete, onAdd, onBatch, onToggle, onApplyBatch }: { items: YoItem[]; batchMode: boolean; selectedIds: string[]; onEdit: (item: YoItem) => void; onDelete: (item: YoItem) => void; onAdd: () => void; onBatch: () => void; onToggle: (id: string) => void; onApplyBatch: (count: 1 | 2) => void }) {
  return <View style={styles.screen}>
    <View style={styles.toolbar}><Text style={styles.sectionTitle}>我的药品</Text><View style={styles.toolbarButtons}><Pressable onPress={onBatch}><Text style={styles.link}>{batchMode ? '完成' : '批量设置'}</Text></Pressable><Pressable style={styles.addCircle} onPress={onAdd}><Text style={styles.addText}>＋</Text></Pressable></View></View>
    {batchMode && <View style={styles.batchBar}><Text style={styles.batchText}>已选 {selectedIds.length} 种</Text><Pressable disabled={!selectedIds.length} onPress={() => onApplyBatch(1)}><Text style={styles.batchAction}>响铃1次</Text></Pressable><Pressable disabled={!selectedIds.length} onPress={() => onApplyBatch(2)}><Text style={styles.batchAction}>响铃2次</Text></Pressable></View>}
    <FlatList data={items} keyExtractor={(item) => item.id} contentContainerStyle={styles.list} ListEmptyComponent={<EmptyState onAdd={onAdd} />} renderItem={({ item }) => <Pressable style={styles.itemCard} onPress={() => batchMode ? onToggle(item.id) : onEdit(item)}><View style={[styles.itemIcon, !item.enabled && { backgroundColor: '#EEE' }]}><Text>💊</Text></View><View style={styles.itemMain}><Text style={styles.itemName}>{item.name}</Text><Text style={styles.itemNote}>{item.note || '点击添加备注'}</Text><Text style={styles.itemRule}>{item.mode === 'interval' ? `每 ${item.intervalHours} 小时` : item.fixedTimes.join('、')}</Text></View>{batchMode ? <View style={[styles.checkbox, selectedIds.includes(item.id) && styles.checkboxOn]}><Text style={styles.checkboxText}>{selectedIds.includes(item.id) ? '✓' : ''}</Text></View> : <View style={styles.itemRight}><Text style={styles.bell}>{item.bellCount === 2 ? '🔔🔔' : '🔔'}</Text><Pressable hitSlop={8} onPress={() => onDelete(item)}><Text style={styles.delete}>删除</Text></Pressable></View>}</Pressable>} />
  </View>;
}

function SettingsScreen({ notificationGranted, onRequest }: { notificationGranted: boolean; onRequest: () => void }) {
  return <ScrollView contentContainerStyle={styles.scroll}><Text style={styles.sectionTitle}>设置</Text><View style={styles.settingCard}><Text style={styles.settingTitle}>提醒权限</Text><Text style={styles.settingSub}>{notificationGranted ? '已允许通知，时间到了会提醒你' : '还没有允许通知，提醒可能不会响'}</Text><Pressable style={styles.secondaryButton} onPress={onRequest}><Text style={styles.secondaryText}>{notificationGranted ? '重新检查通知' : '开启通知权限'}</Text></Pressable><Pressable style={styles.alarmPermissionButton} onPress={() => void openAlarmPermissionSettings()}><Text style={styles.alarmPermissionText}>开启闹钟级权限</Text></Pressable><Text style={styles.permissionHint}>建议开启精确闹钟与锁屏全屏提醒，关屏时也能响铃和振动。</Text></View><View style={styles.settingCard}><Text style={styles.settingTitle}>关于吃哟咯</Text><Text style={styles.settingSub}>每种药品都有自己的确认状态。系统通知被划掉或错过后，App 仍会保留“待确认”，直到你点击“确认已吃药”。</Text></View><View style={styles.settingCard}><Text style={styles.settingTitle}>吃哟咯</Text><Text style={styles.settingSub}>按时吃药提醒 · v0.1.0</Text></View></ScrollView>;
}

function TabButton({ icon, label, active, onPress }: { icon: string; label: string; active: boolean; onPress: () => void }) { return <Pressable style={styles.tab} onPress={onPress}><Text style={[styles.tabIcon, active && styles.tabActive]}>{icon}</Text><Text style={[styles.tabLabel, active && styles.tabActive]}>{label}</Text></Pressable>; }

function OptionPicker({ visible, title, options, value, onSelect, onClose }: { visible: boolean; title: string; options: Array<{ value: string; label: string }>; value: string; onSelect: (value: string) => void; onClose: () => void }) {
  return <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}><Pressable style={styles.pickerBackdrop} onPress={onClose}><Pressable style={styles.pickerSheet} onPress={(event) => event.stopPropagation()}><View style={styles.pickerHeader}><Text style={styles.pickerTitle}>{title}</Text><Pressable onPress={onClose}><Text style={styles.link}>关闭</Text></Pressable></View><FlatList data={options} keyExtractor={(option) => option.value} style={styles.pickerList} renderItem={({ item: option }) => <Pressable style={[styles.pickerOption, option.value === value && styles.pickerOptionOn]} onPress={() => { onSelect(option.value); onClose(); }}><Text style={[styles.pickerOptionText, option.value === value && styles.pickerOptionTextOn]}>{option.label}</Text>{option.value === value && <Text style={styles.check}>✓</Text>}</Pressable>} /></Pressable></Pressable></Modal>;
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
  const save = () => draft.name.trim() ? onSave(draft) : Alert.alert('还差一步', '请先填写药品名称');
  const days: Array<[string, number]> = [['日', 1], ['一', 2], ['二', 3], ['三', 4], ['四', 5], ['五', 6], ['六', 7]];
  const sound = draft.sound ?? 'default';
  const selectedTime = draft.fixedTimes[editingTimeIndex] ?? '08:00';

  return <Modal visible={Boolean(item)} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
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
        <Text style={styles.label}>响铃次数</Text><View style={styles.segment}><Segment label="1 次" active={draft.bellCount === 1} onPress={() => set('bellCount', 1)} /><Segment label="2 次" active={draft.bellCount === 2} onPress={() => set('bellCount', 2)} /></View>
        {draft.bellCount === 2 && <View style={styles.controlBlock}><SelectField label="第二次提醒间隔" value={`间隔 ${draft.secondBellDelayMinutes} 分钟`} onPress={() => setPicker('delay')} /></View>}
        <Text style={styles.label}>提醒铃声</Text><SelectField value={soundLabels[sound]} onPress={() => setPicker('sound')} />
        <View style={styles.switchRow}><View style={styles.switchCopy}><Text style={styles.label}>启用提醒</Text><Text style={styles.helper}>关闭后不会安排新的提醒</Text></View><Switch value={draft.enabled} onValueChange={(value) => { if (value) { set('enabled', true); return; } Alert.alert('关闭提醒？', '关闭后这个药品不会再响铃和振动。', [{ text: '继续开启', style: 'cancel' }, { text: '确认关闭', style: 'destructive', onPress: () => set('enabled', false) }]); }} trackColor={{ true: colors.teal }} thumbColor="#FFF" /></View>
      </ScrollView>
      <View style={styles.modalFooter}><Pressable style={styles.saveButton} onPress={save}><Text style={styles.saveButtonText}>保存提醒</Text></Pressable></View>
      <OptionPicker visible={picker === 'interval'} title="选择提醒间隔" options={intervalOptions} value={String(draft.intervalHours)} onSelect={(value) => set('intervalHours', Number(value))} onClose={() => setPicker(null)} />
      <OptionPicker visible={picker === 'time'} title="选择提醒时间" options={timeOptions.map((value) => ({ value, label: value }))} value={selectedTime} onSelect={(value) => set('fixedTimes', draft.fixedTimes.map((time, index) => index === editingTimeIndex ? value : time))} onClose={() => setPicker(null)} />
      <OptionPicker visible={picker === 'delay'} title="选择第二次提醒间隔" options={delayOptions} value={String(draft.secondBellDelayMinutes)} onSelect={(value) => set('secondBellDelayMinutes', Number(value))} onClose={() => setPicker(null)} />
      <OptionPicker visible={picker === 'sound'} title="选择提醒铃声" options={soundOptions} value={sound} onSelect={(value) => set('sound', value as ReminderSound)} onClose={() => setPicker(null)} />
    </KeyboardAvoidingView>
  </Modal>;
}

function Segment({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) { return <Pressable onPress={onPress} style={[styles.segmentButton, active && styles.segmentActive]}><Text style={[styles.segmentText, active && styles.segmentTextActive]}>{label}</Text></Pressable>; }

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg }, loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg }, loadingIcon: { width: 78, height: 78, borderRadius: 22, marginBottom: 12 }, content: { flex: 1 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, brandRow: { flexDirection: 'row', alignItems: 'center' }, brandIcon: { width: 42, height: 42, borderRadius: 13, marginRight: 10 }, logo: { color: colors.ink, fontSize: 27, fontWeight: '800', letterSpacing: 1 }, subtitle: { color: colors.muted, fontSize: 12, marginTop: 2 }, headerBadge: { width: 42, height: 42, borderRadius: 21, backgroundColor: colors.tealSoft, alignItems: 'center', justifyContent: 'center' }, headerBadgeText: { color: colors.teal, fontSize: 20, fontWeight: '800' },
  scroll: { padding: 20, paddingBottom: 35 }, screen: { flex: 1, paddingHorizontal: 20 }, dateRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }, greeting: { color: colors.ink, fontSize: 21, fontWeight: '800' }, date: { color: colors.muted, marginTop: 5 }, sun: { color: colors.coral, fontSize: 32 }, summary: { backgroundColor: colors.coral, borderRadius: 22, padding: 17, flexDirection: 'row', alignItems: 'center', marginBottom: 24 }, summaryIcon: { width: 42, height: 42, borderRadius: 14, backgroundColor: '#FFF1EC', alignItems: 'center', justifyContent: 'center', marginRight: 12 }, summaryNumber: { color: '#FFF', fontSize: 38, fontWeight: '800', marginRight: 12 }, summaryTitle: { color: '#FFF', fontSize: 18, fontWeight: '700' }, summarySub: { color: '#FFF6F2', marginTop: 4 }, sectionTitle: { color: colors.ink, fontSize: 20, fontWeight: '800', marginBottom: 12 },
  doseCard: { backgroundColor: colors.card, borderRadius: 20, padding: 14, marginBottom: 12, flexDirection: 'row', alignItems: 'center', shadowColor: '#D6B9AB', shadowOpacity: 0.12, shadowRadius: 9, elevation: 2 }, doseIcon: { width: 48, height: 48, borderRadius: 16, backgroundColor: colors.tealSoft, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, doseInfo: { flex: 1 }, doseName: { color: colors.ink, fontSize: 17, fontWeight: '800' }, doseNote: { color: colors.muted, marginTop: 3 }, doseTime: { color: colors.red, fontSize: 12, marginTop: 6 }, doseActions: { alignItems: 'flex-end', marginLeft: 8 }, confirmButton: { backgroundColor: colors.teal, borderRadius: 12, paddingHorizontal: 10, paddingVertical: 9 }, confirmText: { color: '#FFF', fontWeight: '700', fontSize: 12 }, snooze: { color: colors.muted, fontSize: 11, marginTop: 9 }, tip: { flexDirection: 'row', padding: 14, backgroundColor: '#FFF0D9', borderRadius: 16, marginTop: 10 }, tipIcon: { fontSize: 18, color: colors.coral, marginRight: 8 }, tipText: { color: '#886A4A', flex: 1, lineHeight: 19, fontSize: 12 }, empty: { alignItems: 'center', backgroundColor: colors.card, borderRadius: 22, padding: 28 }, emptyEmoji: { fontSize: 38, marginBottom: 10 }, emptyTitle: { color: colors.ink, fontWeight: '800', fontSize: 17, marginBottom: 5 }, muted: { color: colors.muted }, primaryButton: { backgroundColor: colors.coral, paddingHorizontal: 22, paddingVertical: 12, borderRadius: 14, marginTop: 18 }, primaryText: { color: '#FFF', fontWeight: '800' },
  tabs: { height: 75, backgroundColor: '#FFF', borderTopWidth: 1, borderTopColor: colors.line, flexDirection: 'row', justifyContent: 'space-around', paddingTop: 9 }, tab: { alignItems: 'center', flex: 1 }, tabIcon: { fontSize: 21, color: '#B8A59D' }, tabLabel: { color: '#B8A59D', fontSize: 12, marginTop: 3 }, tabActive: { color: colors.coral, fontWeight: '800' }, toolbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 20 }, toolbarButtons: { flexDirection: 'row', alignItems: 'center', gap: 15 }, link: { color: colors.coral, fontWeight: '800' }, addCircle: { width: 38, height: 38, borderRadius: 19, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center' }, addText: { color: '#FFF', fontSize: 24, lineHeight: 28 }, list: { paddingVertical: 10, paddingBottom: 35 }, itemCard: { backgroundColor: colors.card, borderRadius: 18, padding: 14, marginBottom: 10, flexDirection: 'row', alignItems: 'center' }, itemIcon: { backgroundColor: colors.tealSoft, width: 46, height: 46, borderRadius: 15, alignItems: 'center', justifyContent: 'center', marginRight: 12 }, itemMain: { flex: 1 }, itemName: { color: colors.ink, fontSize: 16, fontWeight: '800' }, itemNote: { color: colors.muted, fontSize: 12, marginTop: 3 }, itemRule: { color: colors.coral, fontSize: 12, marginTop: 6 }, itemRight: { alignItems: 'flex-end' }, bell: { fontSize: 13, marginBottom: 7 }, delete: { color: colors.red, fontSize: 12 }, batchBar: { backgroundColor: colors.coralSoft, borderRadius: 14, marginTop: 2, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 14 }, batchText: { color: colors.ink, flex: 1, fontWeight: '700' }, batchAction: { color: colors.coral, fontWeight: '800', fontSize: 12 }, checkbox: { width: 25, height: 25, borderRadius: 8, borderWidth: 2, borderColor: colors.line, alignItems: 'center', justifyContent: 'center' }, checkboxOn: { backgroundColor: colors.coral, borderColor: colors.coral }, checkboxText: { color: '#FFF', fontWeight: '800' },
  settingCard: { backgroundColor: colors.card, borderRadius: 20, padding: 18, marginBottom: 12 }, settingTitle: { color: colors.ink, fontWeight: '800', fontSize: 16 }, settingSub: { color: colors.muted, lineHeight: 20, marginTop: 7 }, secondaryButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.coral, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, marginTop: 14 }, secondaryText: { color: colors.coral, fontWeight: '800' }, alarmPermissionButton: { alignSelf: 'flex-start', borderWidth: 1, borderColor: colors.teal, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 9, marginTop: 10 }, alarmPermissionText: { color: colors.teal, fontWeight: '800' }, permissionHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 9 },
  modal: { flex: 1, backgroundColor: colors.bg }, modalHeader: { minHeight: 62, paddingHorizontal: 20, paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.line, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: '#FFF' }, modalTitle: { color: colors.ink, fontWeight: '800', fontSize: 18 }, headerSpacer: { width: 36 }, formScroll: { flex: 1 }, form: { padding: 20, paddingBottom: 34 }, formIntro: { color: colors.muted, lineHeight: 20, marginBottom: 4 }, label: { color: colors.ink, fontWeight: '800', marginTop: 17, marginBottom: 8 }, helper: { color: colors.muted, fontSize: 12, marginBottom: 8 }, input: { backgroundColor: '#FFF', borderRadius: 14, borderWidth: 1, borderColor: colors.line, color: colors.ink, paddingHorizontal: 14, paddingVertical: 12, fontSize: 16 }, textarea: { minHeight: 74, textAlignVertical: 'top' }, controlBlock: { marginTop: 2 }, segment: { flexDirection: 'row', gap: 8 }, segmentButton: { flex: 1, borderRadius: 12, borderWidth: 1, borderColor: colors.line, paddingVertical: 13, alignItems: 'center', backgroundColor: '#FFF' }, segmentActive: { backgroundColor: colors.coralSoft, borderColor: colors.coral }, segmentText: { color: colors.muted, fontWeight: '700' }, segmentTextActive: { color: colors.coral }, timeRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 8 }, timeFieldWrap: { flex: 1 }, selectField: { minHeight: 49, backgroundColor: '#FFF', borderRadius: 14, borderWidth: 1, borderColor: colors.line, paddingHorizontal: 14, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, selectText: { color: colors.ink, fontSize: 16, fontWeight: '600' }, chevron: { color: colors.coral, fontSize: 22, lineHeight: 22 }, addTimeButton: { paddingVertical: 10 }, weekdays: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 4 }, weekday: { width: 37, height: 37, borderRadius: 19, borderWidth: 1, borderColor: colors.line, backgroundColor: '#FFF', alignItems: 'center', justifyContent: 'center' }, weekdayOn: { backgroundColor: colors.coral, borderColor: colors.coral }, weekdayText: { color: colors.muted, fontWeight: '700' }, weekdayTextOn: { color: '#FFF' }, switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 20, paddingBottom: 4 }, switchCopy: { flex: 1 }, modalFooter: { paddingHorizontal: 20, paddingTop: 10, paddingBottom: Platform.OS === 'ios' ? 22 : 14, borderTopWidth: 1, borderTopColor: colors.line, backgroundColor: '#FFF' }, saveButton: { minHeight: 50, borderRadius: 15, backgroundColor: colors.coral, alignItems: 'center', justifyContent: 'center' }, saveButtonText: { color: '#FFF', fontSize: 16, fontWeight: '800' },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(51,43,43,0.35)', justifyContent: 'flex-end' }, pickerSheet: { maxHeight: '78%', backgroundColor: colors.bg, borderTopLeftRadius: 24, borderTopRightRadius: 24, paddingBottom: 16 }, pickerHeader: { paddingHorizontal: 20, paddingVertical: 16, backgroundColor: '#FFF', borderTopLeftRadius: 24, borderTopRightRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pickerTitle: { color: colors.ink, fontSize: 17, fontWeight: '800' }, pickerList: { paddingHorizontal: 14, paddingTop: 10 }, pickerOption: { minHeight: 48, paddingHorizontal: 16, borderRadius: 13, backgroundColor: '#FFF', marginBottom: 7, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, pickerOptionOn: { backgroundColor: colors.coralSoft, borderWidth: 1, borderColor: colors.coral }, pickerOptionText: { color: colors.ink, fontSize: 16 }, pickerOptionTextOn: { color: colors.coral, fontWeight: '800' }, check: { color: colors.coral, fontSize: 20, fontWeight: '800' },
});