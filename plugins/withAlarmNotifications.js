const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');

const FULL_SCREEN_PERMISSION = 'android.permission.USE_FULL_SCREEN_INTENT';
const BUILDER_RELATIVE_PATH = 'node_modules/expo-notifications/android/src/main/java/expo/modules/notifications/notifications/presentation/builders/ExpoNotificationBuilder.kt';

function withAlarmNotifications(config) {
  config = withAndroidManifest(config, (manifestConfig) => {
    const permissions = manifestConfig.modResults.manifest['uses-permission'] ?? [];
    if (!permissions.some((permission) => permission.$?.['android:name'] === FULL_SCREEN_PERMISSION)) {
      permissions.push({ $: { 'android:name': FULL_SCREEN_PERMISSION } });
      manifestConfig.modResults.manifest['uses-permission'] = permissions;
    }
    return manifestConfig;
  });

  return withDangerousMod(config, ['android', (dangerousConfig) => {
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