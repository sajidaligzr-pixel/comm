/// In-app update check + install (docs/13-roadmap.md) — this app is sideloaded,
/// not distributed through Play Store, so there's no store-managed auto-update at
/// all; this is the only way an already-installed copy ever finds out a newer
/// build exists. Mandatory, not opt-in: `checkForUpdate` reports any build newer
/// than the one running, and `update_prompt.dart`'s card blocks the rest of the
/// app until the user actually taps through `downloadAndInstall` — there is no
/// "later"/"skip" path (see that file's own docstring for the blocking mechanics).
/// Still never silent, though — nothing downloads or installs without that tap;
/// "mandatory" governs whether it can be dismissed, not whether it asks first.
library;

import 'dart:io';
import 'package:dio/dio.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:android_intent_plus/android_intent.dart';
import 'package:android_intent_plus/flag.dart';
import 'package:path_provider/path_provider.dart';

import '../../api/app_config.dart';
import 'update_models.dart';

class UpdateCheckResult {
  final AppVersionInfo info;
  const UpdateCheckResult(this.info);
}

/// A bare `Dio()` instance, deliberately not the app's own cookie-jar-wired
/// `ApiClient` — `/app-version.json` is a plain static file, not an authenticated
/// `/api/*` route (see update_models.dart's own docstring on why), so it needs
/// none of that plumbing and should keep working even for a signed-out or
/// session-expired install.
final Dio _plainDio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 10), receiveTimeout: const Duration(seconds: 10)));

/// Returns `null` on anything short of "there is a genuinely newer build
/// available" — a bad network, a malformed response, or "already up to date" are
/// all the same "nothing to show" outcome to the caller. Deliberately fails OPEN
/// on a check failure (offline, server unreachable, bad JSON) rather than
/// blocking the app when it can't even confirm whether an update exists — being
/// mandatory means "no skipping a confirmed update," not "no internet, no app."
///
/// Android-only, hard gated — found live: `/app-version.json` is one shared file
/// with no per-platform variant (see update_models.dart's own docstring on why
/// it's a single static file), and neither this function nor `AppVersionInfo`
/// ever looked at its `platform` field before comparing `buildNumber`. Every
/// Android-only release bump (this app's version has climbed a lot faster on
/// Android, which ships far more often — see pubspec.yaml's own history) was
/// therefore treated by any iOS install with a lower raw build number as "a
/// newer build exists," triggering update_prompt.dart's overlay — mandatory and
/// deliberately impossible to dismiss short of updating. Its only "Update"
/// button downloads an `.apk` and fires an Android package-install intent
/// (`downloadAndInstall`, `android_intent_plus`), which does nothing on iOS,
/// so an affected phone was left permanently stuck behind that screen. iOS
/// distribution is TestFlight (see this app's own README on why: not
/// sideloaded, unlike Android), which already has its own update mechanism —
/// this feature was only ever meant to exist for Android's sideloaded install,
/// it just never got the runtime check to say so explicitly.
Future<UpdateCheckResult?> checkForUpdate() async {
  if (!Platform.isAndroid) return null;
  try {
    final packageInfo = await PackageInfo.fromPlatform();
    final currentBuild = int.tryParse(packageInfo.buildNumber) ?? 0;

    final response = await _plainDio.get<Map<String, dynamic>>('${AppConfig.apiBaseUrl}/app-version.json');
    final info = AppVersionInfo.fromJson(response.data ?? const {});
    if (info == null || info.buildNumber <= currentBuild) return null;

    return UpdateCheckResult(info);
  } catch (_) {
    return null;
  }
}

String _resolveApkUrl(String apkUrl, int buildNumber) {
  final base = apkUrl.startsWith('http') ? apkUrl : '${AppConfig.apiBaseUrl}$apkUrl';
  // Cache-busting — a fixed filename (apps/web/public/app-version.json's own
  // docstring explains why it's reused across releases rather than versioned)
  // means a stale cached copy at the same URL is a real risk otherwise.
  return Uri.parse(base).replace(queryParameters: {'v': buildNumber.toString()}).toString();
}

/// Downloads the APK to this app's own private cache dir (no storage permission
/// needed — see AndroidManifest.xml's FileProvider comment) and fires the native
/// package installer. `onProgress` receives a 0.0–1.0 fraction; throws on any
/// failure (download or the intent itself) — unlike `checkForUpdate`, this is a
/// user-initiated action with its own visible "Update" tap, so a failure here
/// belongs on screen, not swallowed.
Future<void> downloadAndInstall(String apkUrl, int buildNumber, void Function(double progress) onProgress) async {
  final dir = await getTemporaryDirectory();
  final filePath = '${dir.path}/comm-update.apk';
  final file = File(filePath);
  if (await file.exists()) await file.delete();

  await _plainDio.download(
    _resolveApkUrl(apkUrl, buildNumber),
    filePath,
    onReceiveProgress: (received, total) {
      if (total > 0) onProgress(received / total);
    },
  );

  final packageInfo = await PackageInfo.fromPlatform();
  // Hand-built, not `FileProvider.getUriForFile()` (no cross-platform-safe way to
  // call that Java API from Dart without a dedicated platform channel for
  // something this small) — the exact segments here are load-bearing: they must
  // match the manifest's `android:authorities` and file_paths.xml's
  // `<cache-path name="app_cache" .../>` exactly, see both files' own comments.
  final contentUri = 'content://${packageInfo.packageName}.fileprovider/app_cache/comm-update.apk';

  final intent = AndroidIntent(
    action: 'android.intent.action.VIEW',
    data: contentUri,
    type: 'application/vnd.android.package-archive',
    flags: const [Flag.FLAG_ACTIVITY_NEW_TASK, Flag.FLAG_GRANT_READ_URI_PERMISSION],
  );
  await intent.launch();
}
