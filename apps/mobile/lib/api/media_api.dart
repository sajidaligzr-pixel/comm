/// Client for the object-storage upload/download routes — mirrors
/// `apps/web/lib/media-client.ts`. Deliberately NOT layered on `ApiClient.request`
/// for the actual byte transfer: the upload/download targets these routes return are
/// either this deployment's own local-fs route (a same-origin, token-authenticated
/// URL — no cookie/CSRF involved, same as a real presigned URL) or a genuine S3
/// presigned URL (a different origin entirely). Both cases want a bare HTTP client
/// with no cookie jar attached, not `ApiClient`'s cookie-riding one — see
/// `app/api/media/objects/[objectKey]/route.ts`'s own docstring on why a signed URL
/// intentionally doesn't require a session.
library;

import 'dart:typed_data';
import 'package:dio/dio.dart';

import 'api_client.dart';
import 'app_config.dart';
import 'dtos.dart';

class MediaApi {
  const MediaApi(this._client);
  final ApiClient _client;

  static final Dio _rawDio = Dio(BaseOptions(connectTimeout: const Duration(seconds: 20), receiveTimeout: const Duration(minutes: 5)));

  String _resolve(String url) => url.startsWith('/') ? '${AppConfig.apiBaseUrl}$url' : url;

  Future<CreateUploadUrlResponse> _createUploadUrl(int encryptedSizeBytes) {
    return _client.request(
      '/api/media/upload-url',
      body: {'encryptedSizeBytes': encryptedSizeBytes},
      parse: (data) => CreateUploadUrlResponse.fromJson(data as Map<String, dynamic>),
    );
  }

  /// Uploads already-encrypted bytes (see crypto/attachment_crypto.dart) and returns
  /// the objectKey + size to attach to the message envelope's `attachment` ref.
  Future<({String objectKey, int encryptedSizeBytes})> uploadAttachmentCiphertext(Uint8List ciphertext) async {
    if (ciphertext.length > mediaClientSoftCapBytes) {
      throw ApiException('MEDIA_TOO_LARGE', 'Files must be under ${mediaClientSoftCapBytes ~/ (1024 * 1024)} MB.');
    }

    final minted = await _createUploadUrl(ciphertext.length);
    final target = minted.target;
    final url = _resolve(target.url);

    if (target.method == 'PUT') {
      await _rawDio.putUri(Uri.parse(url), data: Stream.value(ciphertext), options: Options(headers: {'content-length': ciphertext.length}));
    } else {
      final fields = target.fields ?? const {};
      final formMap = <String, dynamic>{...fields, 'file': MultipartFile.fromBytes(ciphertext, filename: 'file')};
      await _rawDio.postUri(Uri.parse(url), data: FormData.fromMap(formMap));
    }

    return (objectKey: minted.objectKey, encryptedSizeBytes: ciphertext.length);
  }

  Future<Uint8List> downloadAttachmentCiphertext(String objectKey) async {
    final res = await _client.request<String>(
      '/api/media/$objectKey/download-url',
      method: 'GET',
      parse: (data) => (data as Map<String, dynamic>)['url'] as String,
    );
    final response = await _rawDio.getUri<List<int>>(Uri.parse(_resolve(res)), options: Options(responseType: ResponseType.bytes));
    return Uint8List.fromList(response.data ?? const []);
  }
}
