/// Plain Dart mirrors of `packages/types`'s zod schemas — hand-written rather than
/// codegen'd (no `freezed`/`json_serializable` build step) so the wire shape is
/// exactly, visibly what the server's zod schemas say, reviewable side-by-side with
/// `packages/types/src/*.ts` the same way the crypto layer mirrors
/// `packages/crypto/src/*.ts`. Every class only carries fields the server actually
/// sends/accepts — see each source file in packages/types for the authoritative
/// shape and validation rules (this layer trusts the server's own validation; it does
/// not re-validate, only encodes/decodes JSON).
library;

// ── Devices / keys (packages/types/src/devices.ts, crypto-keys.ts) ────────────────

class IdentityKeyUpload {
  final String signingPublicKey; // base64
  final String agreementPublicKey; // base64
  const IdentityKeyUpload({required this.signingPublicKey, required this.agreementPublicKey});
  Map<String, dynamic> toJson() => {'signingPublicKey': signingPublicKey, 'agreementPublicKey': agreementPublicKey};
}

class SignedPreKeyUpload {
  final int keyId;
  final String publicKey; // base64
  final String signature; // base64
  const SignedPreKeyUpload({required this.keyId, required this.publicKey, required this.signature});
  Map<String, dynamic> toJson() => {'keyId': keyId, 'publicKey': publicKey, 'signature': signature};
}

class OneTimePreKeyUpload {
  final int keyId;
  final String publicKey; // base64
  const OneTimePreKeyUpload({required this.keyId, required this.publicKey});
  Map<String, dynamic> toJson() => {'keyId': keyId, 'publicKey': publicKey};
}

class DeviceKeyBundle {
  final IdentityKeyUpload identityKey;
  final SignedPreKeyUpload signedPreKey;
  final List<OneTimePreKeyUpload> oneTimePreKeys;
  const DeviceKeyBundle({required this.identityKey, required this.signedPreKey, required this.oneTimePreKeys});
  Map<String, dynamic> toJson() => {
    'identityKey': identityKey.toJson(),
    'signedPreKey': signedPreKey.toJson(),
    'oneTimePreKeys': oneTimePreKeys.map((k) => k.toJson()).toList(),
  };
}

class KeyBundleResponse {
  final IdentityKeyUpload identityKey;
  final int signedPreKeyId;
  final String signedPreKeyPublic;
  final String signedPreKeySignature;
  final int? oneTimePreKeyId;
  final String? oneTimePreKeyPublic;
  const KeyBundleResponse({
    required this.identityKey,
    required this.signedPreKeyId,
    required this.signedPreKeyPublic,
    required this.signedPreKeySignature,
    required this.oneTimePreKeyId,
    required this.oneTimePreKeyPublic,
  });

  static KeyBundleResponse fromJson(Map<String, dynamic> json) {
    final identityKey = json['identityKey'] as Map<String, dynamic>;
    final signedPreKey = json['signedPreKey'] as Map<String, dynamic>;
    final oneTimePreKey = json['oneTimePreKey'] as Map<String, dynamic>?;
    return KeyBundleResponse(
      identityKey: IdentityKeyUpload(
        signingPublicKey: identityKey['signingPublicKey'] as String,
        agreementPublicKey: identityKey['agreementPublicKey'] as String,
      ),
      signedPreKeyId: signedPreKey['keyId'] as int,
      signedPreKeyPublic: signedPreKey['publicKey'] as String,
      signedPreKeySignature: signedPreKey['signature'] as String,
      oneTimePreKeyId: oneTimePreKey?['keyId'] as int?,
      oneTimePreKeyPublic: oneTimePreKey?['publicKey'] as String?,
    );
  }
}

const deviceTypeMobile = 'android'; // DeviceType enum on the server: web | android | desktop

class NewDeviceRegistration {
  final String name;
  final String deviceType;
  final DeviceKeyBundle keyBundle;
  const NewDeviceRegistration({required this.name, required this.deviceType, required this.keyBundle});
  Map<String, dynamic> toJson() => {'name': name, 'deviceType': deviceType, 'keyBundle': keyBundle.toJson()};
}

class DeviceSummary {
  final String id;
  final String name;
  final String deviceType;
  final String status;
  final String linkedAt;
  final String lastActiveAt;
  final bool isCurrentDevice;
  const DeviceSummary({
    required this.id,
    required this.name,
    required this.deviceType,
    required this.status,
    required this.linkedAt,
    required this.lastActiveAt,
    required this.isCurrentDevice,
  });

  static DeviceSummary fromJson(Map<String, dynamic> json) => DeviceSummary(
    id: json['id'] as String,
    name: json['name'] as String,
    deviceType: json['deviceType'] as String,
    status: json['status'] as String,
    linkedAt: json['linkedAt'] as String,
    lastActiveAt: json['lastActiveAt'] as String,
    isCurrentDevice: json['isCurrentDevice'] as bool,
  );
}

class LinkDeviceStartResponse {
  final String linkingToken;
  final String expiresAt;
  final String primaryDeviceIdentityPublicKey;
  const LinkDeviceStartResponse({
    required this.linkingToken,
    required this.expiresAt,
    required this.primaryDeviceIdentityPublicKey,
  });
  static LinkDeviceStartResponse fromJson(Map<String, dynamic> json) => LinkDeviceStartResponse(
    linkingToken: json['linkingToken'] as String,
    expiresAt: json['expiresAt'] as String,
    primaryDeviceIdentityPublicKey: json['primaryDeviceIdentityPublicKey'] as String,
  );
}

// ── Auth (packages/types/src/auth.ts) ──────────────────────────────────────────────

class AuthSessionResponse {
  final String userId;
  final String deviceId;
  final String username;
  final String displayName;
  final bool mustChangePassword;
  const AuthSessionResponse({
    required this.userId,
    required this.deviceId,
    required this.username,
    required this.displayName,
    required this.mustChangePassword,
  });
  static AuthSessionResponse fromJson(Map<String, dynamic> json) => AuthSessionResponse(
    userId: json['userId'] as String,
    deviceId: json['deviceId'] as String,
    username: json['username'] as String,
    displayName: json['displayName'] as String,
    mustChangePassword: json['mustChangePassword'] as bool,
  );
}

class InviteInfoResponse {
  final String username;
  final String displayName;
  final String expiresAt;
  const InviteInfoResponse({required this.username, required this.displayName, required this.expiresAt});
  static InviteInfoResponse fromJson(Map<String, dynamic> json) => InviteInfoResponse(
    username: json['username'] as String,
    displayName: json['displayName'] as String,
    expiresAt: json['expiresAt'] as String,
  );
}

// ── Users (packages/types/src/users.ts) ────────────────────────────────────────────

class UserProfile {
  final String id;
  final String username;
  final String displayName;
  final String? about;
  final String? avatarObjectKey;
  final String status;
  final String createdAt;
  const UserProfile({
    required this.id,
    required this.username,
    required this.displayName,
    required this.about,
    required this.avatarObjectKey,
    required this.status,
    required this.createdAt,
  });
  static UserProfile fromJson(Map<String, dynamic> json) => UserProfile(
    id: json['id'] as String,
    username: json['username'] as String,
    displayName: json['displayName'] as String,
    about: json['about'] as String?,
    avatarObjectKey: json['avatarObjectKey'] as String?,
    status: json['status'] as String,
    createdAt: json['createdAt'] as String,
  );
}

// ── Messages / conversations (packages/types/src/messages.ts) ────────────────────

class MessageEnvelopeUpload {
  final String header; // base64
  final String ciphertext; // base64
  const MessageEnvelopeUpload({required this.header, required this.ciphertext});
  Map<String, dynamic> toJson() => {'header': header, 'ciphertext': ciphertext};
  static MessageEnvelopeUpload fromJson(Map<String, dynamic> json) =>
      MessageEnvelopeUpload(header: json['header'] as String, ciphertext: json['ciphertext'] as String);
}

class X3dhInitPayload {
  final String identityAgreementKey; // base64
  final String ephemeralKey; // base64
  final int usedSignedPreKeyId;
  final int? usedOneTimePreKeyId;
  const X3dhInitPayload({
    required this.identityAgreementKey,
    required this.ephemeralKey,
    required this.usedSignedPreKeyId,
    required this.usedOneTimePreKeyId,
  });
  Map<String, dynamic> toJson() => {
    'identityAgreementKey': identityAgreementKey,
    'ephemeralKey': ephemeralKey,
    'usedSignedPreKeyId': usedSignedPreKeyId,
    'usedOneTimePreKeyId': usedOneTimePreKeyId,
  };
  static X3dhInitPayload fromJson(Map<String, dynamic> json) => X3dhInitPayload(
    identityAgreementKey: json['identityAgreementKey'] as String,
    ephemeralKey: json['ephemeralKey'] as String,
    usedSignedPreKeyId: json['usedSignedPreKeyId'] as int,
    usedOneTimePreKeyId: json['usedOneTimePreKeyId'] as int?,
  );
}

/// A discriminated union in TS (`type: 'direct' | 'group'`) — modeled here as one
/// class with nullable direct-only/group-only fields rather than a Dart sealed-class
/// hierarchy, kept simple since call sites already branch on `type` explicitly, same
/// as every TS call site does per that file's own comment.
class ConversationSummary {
  final String id;
  final String type; // 'direct' | 'group'
  final String disappearingTimer;
  final String? lastMessageAt;
  final int unreadCount;
  final bool archived;
  // type == 'direct'
  final String? otherUserId;
  final String? otherUsername;
  final String? otherDisplayName;
  // type == 'group'
  final String? groupId;
  final String? groupName;
  final int? groupMemberCount;

  const ConversationSummary({
    required this.id,
    required this.type,
    required this.disappearingTimer,
    required this.lastMessageAt,
    required this.unreadCount,
    required this.archived,
    this.otherUserId,
    this.otherUsername,
    this.otherDisplayName,
    this.groupId,
    this.groupName,
    this.groupMemberCount,
  });

  static ConversationSummary fromJson(Map<String, dynamic> json) {
    final type = json['type'] as String;
    final otherUser = json['otherUser'] as Map<String, dynamic>?;
    final group = json['group'] as Map<String, dynamic>?;
    return ConversationSummary(
      id: json['id'] as String,
      type: type,
      disappearingTimer: json['disappearingTimer'] as String,
      lastMessageAt: json['lastMessageAt'] as String?,
      unreadCount: json['unreadCount'] as int,
      archived: json['archived'] as bool,
      otherUserId: otherUser?['id'] as String?,
      otherUsername: otherUser?['username'] as String?,
      otherDisplayName: otherUser?['displayName'] as String?,
      groupId: group?['id'] as String?,
      groupName: group?['name'] as String?,
      groupMemberCount: group?['memberCount'] as int?,
    );
  }

  /// What to show in a conversation list/header regardless of type.
  String displayTitle() => type == 'direct' ? (otherDisplayName ?? otherUsername ?? 'Unknown') : (groupName ?? 'Group');
}

class MessageAttachmentRef {
  final String objectKey;
  final int encryptedSizeBytes;
  const MessageAttachmentRef({required this.objectKey, required this.encryptedSizeBytes});
  Map<String, dynamic> toJson() => {'objectKey': objectKey, 'encryptedSizeBytes': encryptedSizeBytes};
}

class SendMessageRequest {
  final String messageId;
  final String? recipientDeviceId;
  final String envelopeType; // 'x3dh_ratchet_1to1' | 'megolm_group'
  final MessageEnvelopeUpload envelope;
  final X3dhInitPayload? x3dhInit;
  final String contentTypeHint;
  final String? replyToMessageId;
  final String sentAt;
  final MessageAttachmentRef? attachment;

  const SendMessageRequest({
    required this.messageId,
    required this.recipientDeviceId,
    required this.envelopeType,
    required this.envelope,
    required this.x3dhInit,
    required this.contentTypeHint,
    required this.replyToMessageId,
    required this.sentAt,
    this.attachment,
  });

  Map<String, dynamic> toJson() => {
    'messageId': messageId,
    if (recipientDeviceId != null) 'recipientDeviceId': recipientDeviceId,
    'envelopeType': envelopeType,
    'envelope': envelope.toJson(),
    'x3dhInit': x3dhInit?.toJson(),
    'contentTypeHint': contentTypeHint,
    'replyToMessageId': replyToMessageId,
    'sentAt': sentAt,
    if (attachment != null) 'attachment': attachment!.toJson(),
  };
}

class MessageDto {
  final String id;
  final String conversationId;
  final String senderUserId;
  final String senderDeviceId;
  final String recipientDeviceId;
  final String envelopeType;
  final MessageEnvelopeUpload envelope;
  final X3dhInitPayload? x3dhInit;
  final String contentTypeHint;
  final String? replyToMessageId;
  final String sentAt;
  final String serverReceivedAt;
  final String? deliveredAt;
  final String? readAt;

  const MessageDto({
    required this.id,
    required this.conversationId,
    required this.senderUserId,
    required this.senderDeviceId,
    required this.recipientDeviceId,
    required this.envelopeType,
    required this.envelope,
    required this.x3dhInit,
    required this.contentTypeHint,
    required this.replyToMessageId,
    required this.sentAt,
    required this.serverReceivedAt,
    required this.deliveredAt,
    required this.readAt,
  });

  static MessageDto fromJson(Map<String, dynamic> json) => MessageDto(
    id: json['id'] as String,
    conversationId: json['conversationId'] as String,
    senderUserId: json['senderUserId'] as String,
    senderDeviceId: json['senderDeviceId'] as String,
    recipientDeviceId: json['recipientDeviceId'] as String,
    envelopeType: json['envelopeType'] as String,
    envelope: MessageEnvelopeUpload.fromJson(json['envelope'] as Map<String, dynamic>),
    x3dhInit: json['x3dhInit'] != null ? X3dhInitPayload.fromJson(json['x3dhInit'] as Map<String, dynamic>) : null,
    contentTypeHint: json['contentTypeHint'] as String,
    replyToMessageId: json['replyToMessageId'] as String?,
    sentAt: json['sentAt'] as String,
    serverReceivedAt: json['serverReceivedAt'] as String,
    deliveredAt: json['deliveredAt'] as String?,
    readAt: json['readAt'] as String?,
  );
}

class CursorPage<T> {
  final List<T> items;
  final String? nextCursor;
  const CursorPage({required this.items, required this.nextCursor});
  static CursorPage<T> fromJson<T>(Map<String, dynamic> json, T Function(Map<String, dynamic>) itemFromJson) =>
      CursorPage<T>(
        items: (json['items'] as List).map((e) => itemFromJson(e as Map<String, dynamic>)).toList(),
        nextCursor: json['nextCursor'] as String?,
      );
}
