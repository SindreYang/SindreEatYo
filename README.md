# 吃哟咯（SindreEatYo）

药品提醒 App「吃哟咯」，使用 React Native + TypeScript + Expo 实现。当前先完成 Android，iOS 保留后续整体构建。

## 已实现

- 药品名称与备注管理
- 按间隔或固定时间提醒
- 每天/每周/自定义重复字段（第一版 UI 已保留扩展位）
- 响铃 1 次或 2 次，以及第二次响铃间隔
- 通知到达后进入待确认状态
- “确认已吃药”与“稍后 10 分钟”
- 本地持久化
- 简洁中文界面、安全区布局、可点击的“添加/修改/删除”入口
- Android 原生 `AlarmManager.setAlarmClock`、通知渠道、响铃、振动、锁屏和开机恢复
- 设置页可“立即测试响铃和振动”，并可导出不含药品名称和备注的调试日志

## 本地运行

```bash
npm install
npx expo start
```

Windows 可以直接开发和运行 Android；iOS 需要 macOS + Xcode，或交给 GitHub Actions 的 macOS Runner 构建。

## GitHub Actions

- `.github/workflows/android.yml`：Ubuntu Runner 构建可独立启动的 Android Release APK（内置 JS bundle）
- `.github/workflows/ios.yml`：仅手动触发的 iOS 构建占位流程

Android 提醒优先使用原生闹钟和通知链路，使用高优先级通知、闹钟音频、振动、锁屏可见、全屏提醒入口和开机恢复；设置页会读取实际的通知、精确闹钟、全屏提醒状态。即使通知被划掉或错过，App 内仍保留“待确认吃药”。

## 导出调试日志

如果真机上没有响铃、没有通知、状态显示不正确：

1. 打开“设置”。
2. 点击“立即测试响铃和振动”。
3. 返回设置，点击“导出调试日志”。
4. 在系统分享面板中发送日志文件内容给开发者。

日志只记录权限状态、调度数量、测试操作和错误信息，不记录药品名称、备注或提醒内容。

真机 iOS 发布包仍需要 Apple Developer 证书、Provisioning Profile，以及 GitHub Secrets。普通系统通知可能被用户划掉，App 内“待确认”状态不会被清除；若需要无视静音/勿扰模式的强提醒，需要另行申请平台权限。
