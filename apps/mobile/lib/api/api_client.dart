/// Thin REST client — the mobile counterpart to `apps/web/lib/api-client.ts`, adapted
/// for a native app talking to the same cookie-session backend:
///
/// - `apps/web`'s `apiFetch` rides the browser's own cookie jar for free
///   (`credentials: 'include'`); there is no browser here, so a persisted
///   `PersistCookieJar` (cookie_jar) plus `dio_cookie_manager`'s interceptor does the
///   same job — read/store `comm_at`/`comm_rt`/`comm_csrf` exactly like a browser
///   would, surviving app restarts.
/// - The CSRF double-submit header (`x-csrf-token`, echoing the non-HttpOnly
///   `comm_csrf` cookie) is read straight out of the cookie jar rather than
///   `document.cookie`, then attached the same way on every mutating request.
/// - The `{ ok: true, data } | { ok: false, error }` envelope
///   (packages/types/src/errors.ts) is unwrapped the same way, throwing `ApiException`
///   on the error branch so callers can `catch` on `.code` exactly like the web
///   client's `ApiError`.
library;

import 'dart:io';
import 'package:dio/dio.dart';
import 'package:dio_cookie_manager/dio_cookie_manager.dart';
import 'package:cookie_jar/cookie_jar.dart';
import 'package:path_provider/path_provider.dart';

import 'app_config.dart';

class ApiException implements Exception {
  final String code;
  final String message;
  const ApiException(this.code, this.message);
  @override
  String toString() => 'ApiException($code): $message';
}

const _csrfCookieName = 'comm_csrf';
const _csrfHeaderName = 'x-csrf-token';

class ApiClient {
  ApiClient._(this._dio, this._cookieJar);

  final Dio _dio;
  final PersistCookieJar _cookieJar;

  static ApiClient? _instance;

  /// Must be awaited once at app startup (main.dart) before any request is made —
  /// the persisted cookie jar needs a real directory on disk, which is itself async.
  static Future<ApiClient> initialize() async {
    if (_instance != null) return _instance!;

    final supportDir = await getApplicationSupportDirectory();
    final cookieJar = PersistCookieJar(
      storage: FileStorage('${supportDir.path}/.cookies/'),
    );

    final dio = Dio(
      BaseOptions(
        baseUrl: AppConfig.apiBaseUrl,
        connectTimeout: const Duration(seconds: 15),
        receiveTimeout: const Duration(seconds: 30),
        headers: {'content-type': 'application/json'},
        // The envelope's error branch is still valid JSON with a normal 4xx/5xx
        // status — handled explicitly below, not via dio's own exception path, so
        // this is set to read the body on every status rather than throwing early.
        validateStatus: (_) => true,
      ),
    );
    dio.interceptors.add(CookieManager(cookieJar));

    _instance = ApiClient._(dio, cookieJar);
    return _instance!;
  }

  static ApiClient get instance {
    final i = _instance;
    if (i == null) {
      throw StateError(
        'ApiClient.initialize() must be awaited before use (see main.dart).',
      );
    }
    return i;
  }

  /// Shared with `realtime/ws_client.dart`, which needs the same persisted cookies
  /// to authenticate the WS upgrade (no browser here to ride them automatically).
  PersistCookieJar get cookieJar => _cookieJar;

  /// Set by `AuthController`'s constructor — the one place this app can react to
  /// "the session is genuinely, unrecoverably gone" (an access token expired AND
  /// the refresh attempt below that should have silently fixed it also failed —
  /// see `_refreshAccessToken`'s docstring) regardless of which screen's request
  /// happened to be the one that discovered it.
  void Function()? onSessionExpired;

  Future<String?> _readCsrfToken() async {
    final uri = Uri.parse(AppConfig.apiBaseUrl);
    final cookies = await _cookieJar.loadForRequest(uri);
    for (final cookie in cookies) {
      if (cookie.name == _csrfCookieName) return cookie.value;
    }
    return null;
  }

  static const _refreshPath = '/api/auth/refresh';

  /// Coalesces concurrent refresh attempts — several requests can discover an
  /// expired access token around the same moment (e.g. a screen's own parallel
  /// fetches), and only one of them should actually call `/api/auth/refresh`;
  /// the rest just wait on that same in-flight attempt rather than each
  /// triggering their own (which would race the server's refresh-token
  /// rotation and fail all but one anyway — docs/07-auth-architecture.md).
  Future<bool>? _refreshInFlight;

  Future<bool> _refreshAccessToken() {
    return _refreshInFlight ??= _doRefresh().whenComplete(
      () => _refreshInFlight = null,
    );
  }

  Future<bool> _doRefresh() async {
    try {
      // Deliberately not requestVoid/request<T> — those funnel back through
      // this same auth-expiry handling, which would recurse the moment a
      // refresh itself ever came back AUTH_EXPIRED. No CSRF header either:
      // the server route itself doesn't require one for this one endpoint —
      // it authenticates purely off the HttpOnly refresh-token cookie, which
      // a cross-site request can't forge the value of in the first place.
      final res = await _dio.request<dynamic>(
        _refreshPath,
        options: Options(method: 'POST'),
      );
      final json = res.data;
      return json is Map<String, dynamic> && json['ok'] == true;
    } catch (_) {
      return false;
    }
  }

  Future<Response<dynamic>> _rawCall(
    String path,
    String method,
    Object? body,
    Map<String, dynamic>? query,
  ) async {
    final headers = <String, dynamic>{};
    if (method != 'GET') {
      final csrf = await _readCsrfToken();
      if (csrf != null) headers[_csrfHeaderName] = csrf;
    }
    try {
      return await _dio.request<dynamic>(
        path,
        data: body,
        queryParameters: query,
        options: Options(method: method, headers: headers),
      );
    } on DioException catch (e) {
      throw ApiException(
        'NETWORK_ERROR',
        e.message ?? 'Could not reach the server.',
      );
    }
  }

  Future<T> request<T>(
    String path, {
    String? method,
    Object? body,
    Map<String, dynamic>? query,
    required T Function(dynamic data) parse,
  }) async {
    final resolvedMethod = method ?? (body != null ? 'POST' : 'GET');
    var res = await _rawCall(path, resolvedMethod, body, query);
    var json = res.data;

    // Access tokens are short-lived by design (~15 min — docs/07-auth-
    // architecture.md) specifically so the server can refresh them
    // transparently; that only works if a client actually calls
    // /api/auth/refresh when one expires. Found live: nothing anywhere in
    // this app (nor, it turns out, apps/web — neither client ever calls this
    // route) was doing that, so every session hit a hard 15-minute wall of
    // real use before every subsequent request started failing with "Your
    // session has expired." This is that missing piece: transparently
    // refresh and retry the one request that discovered it, once, rather
    // than surfacing an auth error to whatever screen happened to be
    // mid-action when the clock ran out.
    if (json is Map<String, dynamic> &&
        json['ok'] != true &&
        path != _refreshPath) {
      final code = (json['error'] as Map<String, dynamic>?)?['code'] as String?;
      if (code == 'AUTH_EXPIRED' && await _refreshAccessToken()) {
        res = await _rawCall(path, resolvedMethod, body, query);
        json = res.data;
      }
    }

    if (json is! Map<String, dynamic>) {
      throw ApiException(
        'INTERNAL',
        'Malformed response from server (status ${res.statusCode}).',
      );
    }
    if (json['ok'] != true) {
      final error = json['error'] as Map<String, dynamic>?;
      final code = (error?['code'] as String?) ?? 'INTERNAL';
      // Only AUTH_EXPIRED surviving a refresh attempt means the session is
      // truly gone (the refresh token itself is expired/revoked/reuse-
      // detected). Deliberately NOT triggered on a bare AUTH_INVALID/
      // DEVICE_REVOKED here — both codes are also returned for entirely
      // routine, not-yet-signed-in failures (a wrong password on the login
      // screen, a stale remembered device id AuthController.login already
      // handles locally) that must never be misread as "force-sign-out an
      // active session."
      if (code == 'AUTH_EXPIRED') onSessionExpired?.call();
      throw ApiException(
        code,
        (error?['message'] as String?) ?? 'Something went wrong.',
      );
    }
    return parse(json['data']);
  }

  Future<void> requestVoid(String path, {String? method, Object? body}) =>
      request<void>(path, method: method, body: body, parse: (_) {});

  /// Called on logout — clears every persisted cookie (equivalent to the web
  /// client's server-issued `clearAuthCookies` taking effect locally too, so a
  /// subsequent app launch doesn't try to reuse a session the user just ended).
  Future<void> clearCookies() => _cookieJar.deleteAll();
}

/// Marker used by callers that need to distinguish "definitely offline/unreachable"
/// from a real server-side error code — kept here rather than importing `dart:io`
/// elsewhere just for `SocketException`.
bool isNetworkError(Object err) =>
    err is ApiException && err.code == 'NETWORK_ERROR' ||
    err is SocketException;
