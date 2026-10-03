const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const FULL_SCREEN_PERMISSION = 'android.permission.USE_FULL_SCREEN_INTENT';
const BATTERY_PERMISSION = 'android.permission.REQUEST_IGNORE_BATTERY_OPTIMIZATIONS';
const BUILDER_RELATIVE_PATH = 'node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt';
const NATIVE_SOURCE_RELATIVE_PATH = 'plugins/native/EatYoAlarm.kt';
const PACKAGE_PATH = 'com/sindreyang/sindreeatyo';

function withAlarmNotifications(config) {
  config = withAndroidManifest(config, (manifestConfig) => {
    const permissions = manifestConfig.modResults.manifest['uses-permission'] ?? [];
    if (!permissions.some((permission) => permission.$?.['android:name'] === FULL_SCREEN_PERMISSION)) {
      permissions.push({ $: { 'android:name': FULL_SCREEN_PERMISSION } });
    }
    if (!permissions.some((permission) => permission.$?.['android:name'] === BATTERY_PERMISSION)) permissions.push({ $: { 'android:name': BATTERY_PERMISSION } });
    manifestConfig.modResults.manifest['uses-permission'] = permissions;
    const application = manifestConfig.modResults.manifest.application?.[0];
    if (application) {
      application.receiver = application.receiver ?? [];
      const receivers = application.receiver;
      if (!receivers.some((receiver) => receiver.$?.['android:name'] === '.MedicationAlarmReceiver')) {
        receivers.push({ $: { 'android:name': '.MedicationAlarmReceiver', 'android:enabled': 'true', 'android:exported': 'false' } });
      }
      if (!receivers.some((receiver) => receiver.$?.['android:name'] === '.MedicationBootReceiver')) {
        receivers.push({
          $: { 'android:name': '.MedicationBootReceiver', 'android:enabled': 'true', 'android:exported': 'true' },
          'intent-filter': [{ action: [
            { $: { 'android:name': 'android.intent.action.BOOT_COMPLETED' } },
            { $: { 'android:name': 'android.intent.action.MY_PACKAGE_REPLACED' } },
            { $: { 'android:name': 'android.intent.action.QUICKBOOT_POWERON' } },
            { $: { 'android:name': 'com.htc.intent.action.QUICKBOOT_POWERON' } },
          ] }],
        });
      }
    }
    return manifestConfig;
  });

  return withDangerousMod(config, ['android', (dangerousConfig) => {
    const projectRoot = dangerousConfig.modRequest.projectRoot;
    const packageDir = path.join(dangerousConfig.modRequest.platformProjectRoot, 'app', 'src', 'main', 'java', PACKAGE_PATH);
    fs.mkdirSync(packageDir, { recursive: true });
    const nativeSource = path.join(projectRoot, NATIVE_SOURCE_RELATIVE_PATH);
    if (!fs.existsSync(nativeSource)) throw new Error(`Missing ${NATIVE_SOURCE_RELATIVE_PATH}`);
    fs.copyFileSync(nativeSource, path.join(packageDir, 'EatYoAlarm.kt'));

    const mainApplicationPath = path.join(packageDir, 'MainApplication.kt');
    let mainApplication = fs.readFileSync(mainApplicationPath, 'utf8');
    if (!mainApplication.includes('AlarmPermissionPackage()')) {
      const packageMarker = 'PackageList(this).packages.apply {';
      if (mainApplication.includes(packageMarker)) {
        mainApplication = mainApplication.replace(packageMarker, `${packageMarker}\n              add(AlarmPermissionPackage())`);
      } else {
        const packageExpression = 'PackageList(this).packages';
        mainApplication = mainApplication.replace(packageExpression, `${packageExpression}.apply {\n              add(AlarmPermissionPackage())\n            }`);
      }
      fs.writeFileSync(mainApplicationPath, mainApplication);
    }

    const mainActivityPath = path.join(packageDir, 'MainActivity.kt');
    let mainActivity = fs.readFileSync(mainActivityPath, 'utf8');
    if (!mainActivity.includes('SINDRE_ALARM_ACTIVITY')) {
      if (!mainActivity.includes('import android.content.Intent')) {
        mainActivity = mainActivity.replace('import android.os.Bundle', 'import android.os.Bundle\nimport android.content.Intent');
      }
      const alarmBlock = `    // SINDRE_ALARM_ACTIVITY: wake the screen for medication alarms.\n    if (intent?.getBooleanExtra("alarmMode", false) == true) {\n      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) {\n        setShowWhenLocked(true)\n        setTurnScreenOn(true)\n      }\n      window.addFlags(\n        android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON or\n          android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or\n          android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON or\n          android.view.WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD\n      )\n    }\n`;
      mainActivity = mainActivity.replace('    super.onCreate(null)', `${alarmBlock}    super.onCreate(null)`);
      const intentMethod = `\n  override fun onNewIntent(intent: Intent?) {\n    super.onNewIntent(intent)\n    if (intent?.getBooleanExtra("alarmMode", false) == true) {\n      setIntent(intent)\n    }\n  }\n`;
      const javadocMarker = '  /**\n   * Returns the name of the main component';
      mainActivity = mainActivity.replace(javadocMarker, `${intentMethod}\n${javadocMarker}`);
      fs.writeFileSync(mainActivityPath, mainActivity);
    }

    const builderPath = path.join(dangerousConfig.modRequest.projectRoot, BUILDER_RELATIVE_PATH);
    if (!fs.existsSync(builderPath)) return dangerousConfig;
    let source = fs.readFileSync(builderPath, 'utf8');
    if (source.includes('SINDRE_ALARM_FULLSCREEN')) return dangerousConfig;

    source = source.replace('import android.app.Notification\n', 'import android.app.Notification\nimport android.app.PendingIntent\n');
    source = source.replace('import android.content.Context\n', 'import android.content.Context\nimport android.content.Intent\n');
    const marker = '    val content = notificationContent\n';
    const addition = `    // SINDRE_ALARM_FULLSCREEN: show medication reminders over the lock screen.\n    if (content.body?.optBoolean("alarmMode") == true) {\n      val launchIntent = context.packageManager.getLaunchIntentForPackage(context.packageName)\n      launchIntent?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)\n      launchIntent?.let { intent ->\n        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) PendingIntent.FLAG_IMMUTABLE else 0\n        val fullScreenIntent = PendingIntent.getActivity(context, notification.notificationRequest.identifier.hashCode(), intent, flags)\n        builder.setFullScreenIntent(fullScreenIntent, true)\n      }\n    }\n`;
    if (!source.includes(marker)) throw new Error('expo-notifications builder marker not found');
    source = source.replace(marker, marker + addition);
    fs.writeFileSync(builderPath, source);
    return dangerousConfig;
  }]);
}

module.exports = withAlarmNotifications;
