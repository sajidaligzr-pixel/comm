library;

/// `GET /app-version.json` response — a plain static file under
/// `apps/web/public/` (see that file's own docstring for the release process),
/// not an authenticated `/api/*` route: this has to be readable by a copy of the
/// app that might be running a genuinely ancient build, possibly even before it
/// has ever logged in.
class AppVersionInfo {
  final int buildNumber;
  final String versionName;
  final String apkUrl;
  final String? releaseNotes;

  const AppVersionInfo({
    required this.buildNumber,
    required this.versionName,
    required this.apkUrl,
    this.releaseNotes,
  });

  static AppVersionInfo? fromJson(Map<String, dynamic> json) {
    final buildNumber = json['buildNumber'];
    final versionName = json['versionName'];
    final apkUrl = json['apkUrl'];
    if (buildNumber is! int || versionName is! String || apkUrl is! String) {
      return null; // malformed — treated the same as "couldn't check," never crashes the app
    }
    return AppVersionInfo(
      buildNumber: buildNumber,
      versionName: versionName,
      apkUrl: apkUrl,
      releaseNotes: json['releaseNotes'] is String ? json['releaseNotes'] as String : null,
    );
  }
}
