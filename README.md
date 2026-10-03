# 吃哟咯（SindreEatYo）

跨平台「吃哟了」提醒 App，使用 React Native + TypeScript + Expo 实现，目标平台为 Android 与 iOS。

## 已实现

- 哟品名称与备注管理
- 按间隔或固定时间提醒
- 每天/每周/自定义重复字段（第一版 UI 已保留扩展位）
- 响铃 1 次或 2 次，以及第二次响铃间隔
- 批量设置响铃次数
- 通知到达后进入待确认状态
- “确认已吃哟”与“稍后 10 分钟”
- 本地持久化
- Q 版、简洁中文界面

## 本地运行

```bash
npm install
npx expo start
```

Windows 可以直接开发和运行 Android；iOS 需要 macOS + Xcode，或交给 GitHub Actions 的 macOS Runner 构建。

## GitHub Actions

- `.github/workflows/android.yml`：Ubuntu Runner 构建可独立启动的 Android Release APK（内置 JS bundle）
- `.github/workflows/ios.yml`：macOS Runner 构建未签名 iOS Simulator App

Android 提醒会使用高优先级通知、振动、锁屏可见和全屏提醒入口；首次添加药品时，建议开启精确闹钟与锁屏全屏提醒权限。即使通知被划掉或错过，App 内仍保留“待确认吃药”。

真机 iOS 发布包仍需要 Apple Developer 证书、Provisioning Profile，以及 GitHub Secrets。普通系统通知可能被用户划掉，App 内“待确认”状态不会被清除；若需要无视静音/勿扰模式的强提醒，需要另行申请平台权限。