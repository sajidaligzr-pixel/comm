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
  const IdentityKeyUpload({
    required this.signingPublicKey,
    required this.agreementPublicKey,
  });
  Map<String, dynamic> toJson() => {
    'signingPublicKey': signingPublicKey,
    'agreementPublicKey': agreementPublicKey,
  };
}

class SignedPreKeyUpload {
  final int keyId;
  final String publicKey; // base64
  final String signature; // base64
  const SignedPreKeyUpload({
    required this.keyId,
    required this.publicKey,
    required this.signature,
  });
  Map<String, dynamic> toJson() => {
    'keyId': keyId,
    'publicKey': publicKey,
    'signature': signature,
  };
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
  const DeviceKeyBundle({
    required this.identityKey,
    required this.signedPreKey,
    required this.oneTimePreKeys,
  });
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

const deviceTypeMobile =
    'android'; // DeviceType enum on the server: web | android | desktop

class NewDeviceRegistration {
  final String name;
  final String deviceType;
  final DeviceKeyBundle keyBundle;
  const NewDeviceRegistration({
    required this.name,
    required this.deviceType,
    required this.keyBundle,
  });
  Map<String, dynamic> toJson() => {
    'name': name,
    'deviceType': deviceType,
    'keyBundle': keyBundle.toJson(),
  };
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
  static LinkDeviceStartResponse fromJson(Map<String, dynamic> json) =>
      LinkDeviceStartResponse(
        linkingToken: json['linkingToken'] as String,
        expiresAt: json['expiresAt'] as String,
        primaryDeviceIdentityPublicKey:
            json['primaryDeviceIdentityPublicKey'] as String,
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
  static AuthSessionResponse fromJson(Map<String, dynamic> json) =>
      AuthSessionResponse(
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
  const InviteInfoResponse({
    required this.username,
    required this.displayName,
    required this.expiresAt,
  });
  static InviteInfoResponse fromJson(Map<String, dynamic> json) =>
      InviteInfoResponse(
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
      MessageEnvelopeUpload(
        header: json['header'] as String,
        ciphertext: json['ciphertext'] as String,
      );
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
  final bool pinned;
  // type == 'direct'
  final String? otherUserId;
  final String? otherUsername;
  final String? otherDisplayName;

  /// Whether the CALLER has blocked `otherUserId` (docs/13-roadmap.md) — null
  /// for a group conversation, same as the other `other*` fields.
  final bool? callerHasBlockedOtherUser;
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
    required this.pinned,
    this.otherUserId,
    this.otherUsername,
    this.otherDisplayName,
    this.callerHasBlockedOtherUser,
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
      pinned: json['pinned'] as bool? ?? false,
      otherUserId: otherUser?['id'] as String?,
      otherUsername: otherUser?['username'] as String?,
      otherDisplayName: otherUser?['displayName'] as String?,
      callerHasBlockedOtherUser: json['callerHasBlockedOtherUser'] as bool?,
      groupId: group?['id'] as String?,
      groupName: group?['name'] as String?,
      groupMemberCount: group?['memberCount'] as int?,
    );
  }

  /// What to show in a conversation list/header regardless of type.
  String displayTitle() => type == 'direct'
      ? (otherDisplayName ?? otherUsername ?? 'Unknown')
      : (groupName ?? 'Group');

  /// Only the fields chats_list_screen.dart's optimistic archive/pin toggles
  /// and thread_screen.dart's disappearing-timer menu actually need to change
  /// — not a general-purpose copyWith over every field.
  ConversationSummary copyWith({
    bool? archived,
    bool? pinned,
    String? disappearingTimer,
    bool? callerHasBlockedOtherUser,
  }) => ConversationSummary(
    id: id,
    type: type,
    disappearingTimer: disappearingTimer ?? this.disappearingTimer,
    lastMessageAt: lastMessageAt,
    unreadCount: unreadCount,
    archived: archived ?? this.archived,
    pinned: pinned ?? this.pinned,
    otherUserId: otherUserId,
    otherUsername: otherUsername,
    otherDisplayName: otherDisplayName,
    callerHasBlockedOtherUser:
        callerHasBlockedOtherUser ?? this.callerHasBlockedOtherUser,
    groupId: groupId,
    groupName: groupName,
    groupMemberCount: groupMemberCount,
  );
}

/// `GET /api/messages/starred` — mirrors apps/web's identical DTO
/// (packages/types/src/messages.ts), metadata-only for the same reason: the
/// server has no plaintext to give back (E2E). The client resolves each entry
/// against its own local decrypted cache (`loadCachedMessages` for
/// `conversationId`, then find by `messageId`).
class StarredMessageDto {
  final String messageId;
  final String conversationId;
  final String starredAt;
  const StarredMessageDto({
    required this.messageId,
    required this.conversationId,
    required this.starredAt,
  });
  static StarredMessageDto fromJson(Map<String, dynamic> json) =>
      StarredMessageDto(
        messageId: json['messageId'] as String,
        conversationId: json['conversationId'] as String,
        starredAt: json['starredAt'] as String,
      );
}

/// `GET /api/messages/:id/receipts` — "seen by" for a GROUP message, mirrors
/// apps/web's identical DTO (packages/types/src/messages.ts). One entry per
/// member who has at least one `MessageRecipient` row for this message.
class MessageReceiptDto {
  final String userId;
  final String username;
  final String displayName;
  final String? deliveredAt;
  final String? readAt;
  const MessageReceiptDto({
    required this.userId,
    required this.username,
    required this.displayName,
    required this.deliveredAt,
    required this.readAt,
  });
  static MessageReceiptDto fromJson(Map<String, dynamic> json) =>
      MessageReceiptDto(
        userId: json['userId'] as String,
        username: json['username'] as String,
        displayName: json['displayName'] as String,
        deliveredAt: json['deliveredAt'] as String?,
        readAt: json['readAt'] as String?,
      );
}

/// Blocked users (docs/13-roadmap.md) — mirrors apps/web's identical DTO
/// (packages/types/src/blocking.ts).
class BlockedUserDto {
  final String userId;
  final String username;
  final String displayName;
  final String blockedAt;
  const BlockedUserDto({
    required this.userId,
    required this.username,
    required this.displayName,
    required this.blockedAt,
  });
  static BlockedUserDto fromJson(Map<String, dynamic> json) => BlockedUserDto(
    userId: json['userId'] as String,
    username: json['username'] as String,
    displayName: json['displayName'] as String,
    blockedAt: json['blockedAt'] as String,
  );
}

class MessageAttachmentRef {
  final String objectKey;
  final int encryptedSizeBytes;
  const MessageAttachmentRef({
    required this.objectKey,
    required this.encryptedSizeBytes,
  });
  Map<String, dynamic> toJson() => {
    'objectKey': objectKey,
    'encryptedSizeBytes': encryptedSizeBytes,
  };
}

/// One target device's own independently-encrypted envelope — a `direct` send's
/// `recipients` list carries one of these per target device (every other member's
/// active devices, plus the sender's own other active devices); a `group` send has
/// no `recipients` at all (one shared envelope on `SendMessageRequest` itself
/// instead — every member already shares one Megolm-style session).
class RecipientEnvelope {
  final String deviceId;
  final MessageEnvelopeUpload envelope;
  final X3dhInitPayload? x3dhInit;
  const RecipientEnvelope({
    required this.deviceId,
    required this.envelope,
    required this.x3dhInit,
  });
  Map<String, dynamic> toJson() => {
    'deviceId': deviceId,
    'envelope': envelope.toJson(),
    'x3dhInit': x3dhInit?.toJson(),
  };
}

class SendMessageRequest {
  final String messageId;
  final String envelopeType; // 'x3dh_ratchet_1to1' | 'megolm_group'
  /// Group sends only — the one shared envelope every member decrypts.
  final MessageEnvelopeUpload? envelope;
  final X3dhInitPayload? x3dhInit;

  /// Direct sends only — one entry per target device. Exactly one of
  /// `envelope`/`recipients` must be set (mirrors `SendMessageRequest`'s own
  /// `.refine()` in packages/types/src/messages.ts).
  final List<RecipientEnvelope>? recipients;
  final String contentTypeHint;
  final String? replyToMessageId;
  final String sentAt;
  final MessageAttachmentRef? attachment;

  const SendMessageRequest({
    required this.messageId,
    required this.envelopeType,
    this.envelope,
    this.x3dhInit,
    this.recipients,
    required this.contentTypeHint,
    required this.replyToMessageId,
    required this.sentAt,
    this.attachment,
  });

  Map<String, dynamic> toJson() => {
    'messageId': messageId,
    'envelopeType': envelopeType,
    if (envelope != null) 'envelope': envelope!.toJson(),
    if (envelope != null) 'x3dhInit': x3dhInit?.toJson(),
    if (recipients != null)
      'recipients': recipients!.map((r) => r.toJson()).toList(),
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
    envelope: MessageEnvelopeUpload.fromJson(
      json['envelope'] as Map<String, dynamic>,
    ),
    x3dhInit: json['x3dhInit'] != null
        ? X3dhInitPayload.fromJson(json['x3dhInit'] as Map<String, dynamic>)
        : null,
    contentTypeHint: json['contentTypeHint'] as String,
    replyToMessageId: json['replyToMessageId'] as String?,
    sentAt: json['sentAt'] as String,
    serverReceivedAt: json['serverReceivedAt'] as String,
    deliveredAt: json['deliveredAt'] as String?,
    readAt: json['readAt'] as String?,
  );
}

// ── Groups (packages/types/src/groups.ts) ──────────────────────────────────────────

class GroupMemberDto {
  final String userId;
  final String username;
  final String displayName;
  final String role; // 'member' | 'admin'
  final String joinedAt;
  const GroupMemberDto({
    required this.userId,
    required this.username,
    required this.displayName,
    required this.role,
    required this.joinedAt,
  });
  static GroupMemberDto fromJson(Map<String, dynamic> json) => GroupMemberDto(
    userId: json['userId'] as String,
    username: json['username'] as String,
    displayName: json['displayName'] as String,
    role: json['role'] as String,
    joinedAt: json['joinedAt'] as String,
  );
}

class GroupSummary {
  final String id;
  final String conversationId;
  final String name;
  final String? description;
  final bool onlyAdminsCanMessage;
  // A freshly-minted signed download URL, not the raw object key — see
  // GroupSummary.avatarUrl's own docstring (packages/types/src/groups.ts). Null
  // means no avatar set; both clients fall back to initials.
  final String? avatarUrl;
  final String callerRole;
  final List<GroupMemberDto> members;
  final String createdAt;
  const GroupSummary({
    required this.id,
    required this.conversationId,
    required this.name,
    required this.description,
    required this.onlyAdminsCanMessage,
    required this.avatarUrl,
    required this.callerRole,
    required this.members,
    required this.createdAt,
  });
  static GroupSummary fromJson(Map<String, dynamic> json) => GroupSummary(
    id: json['id'] as String,
    conversationId: json['conversationId'] as String,
    name: json['name'] as String,
    description: json['description'] as String?,
    onlyAdminsCanMessage: json['onlyAdminsCanMessage'] as bool,
    avatarUrl: json['avatarUrl'] as String?,
    callerRole: json['callerRole'] as String,
    members: (json['members'] as List)
        .map((e) => GroupMemberDto.fromJson(e as Map<String, dynamic>))
        .toList(),
    createdAt: json['createdAt'] as String,
  );
}

/// `GET`/`POST /api/groups/:id/invite-link` response — see
/// `GroupInviteLink.token`'s own schema docstring (packages/database) for why the
/// server always returns the raw, re-shareable token rather than a hash.
class GroupInviteLinkDto {
  final String token;
  final String groupId;
  const GroupInviteLinkDto({required this.token, required this.groupId});
  static GroupInviteLinkDto fromJson(Map<String, dynamic> json) =>
      GroupInviteLinkDto(
        token: json['token'] as String,
        groupId: json['groupId'] as String,
      );
}

class GroupMemberTarget {
  final String userId;
  final String deviceId;
  const GroupMemberTarget({required this.userId, required this.deviceId});
  static GroupMemberTarget fromJson(Map<String, dynamic> json) =>
      GroupMemberTarget(
        userId: json['userId'] as String,
        deviceId: json['deviceId'] as String,
      );
}

class GroupKeyShareDto {
  final String id;
  final String groupId;
  final int epoch;
  final String fromDeviceId;
  final String fromUserId;
  final MessageEnvelopeUpload envelope;
  final X3dhInitPayload? x3dhInit;
  final String createdAt;
  const GroupKeyShareDto({
    required this.id,
    required this.groupId,
    required this.epoch,
    required this.fromDeviceId,
    required this.fromUserId,
    required this.envelope,
    required this.x3dhInit,
    required this.createdAt,
  });
  static GroupKeyShareDto fromJson(Map<String, dynamic> json) =>
      GroupKeyShareDto(
        id: json['id'] as String,
        groupId: json['groupId'] as String,
        epoch: json['epoch'] as int,
        fromDeviceId: json['fromDeviceId'] as String,
        fromUserId: json['fromUserId'] as String,
        envelope: MessageEnvelopeUpload.fromJson(
          json['envelope'] as Map<String, dynamic>,
        ),
        x3dhInit: json['x3dhInit'] != null
            ? X3dhInitPayload.fromJson(json['x3dhInit'] as Map<String, dynamic>)
            : null,
        createdAt: json['createdAt'] as String,
      );
}

// ── Media (packages/types/src/media.ts) ────────────────────────────────────────────

/// Advisory client-side pre-check only — matches the server's own default
/// (apps/web/server/modules/media/service.ts); the server's own cap is authoritative.
const mediaClientSoftCapBytes = 25 * 1024 * 1024;

class UploadTarget {
  final String method; // 'PUT' | 'POST'
  final String url;
  final Map<String, String>?
  fields; // present only for POST (presigned-POST form fields)
  const UploadTarget({required this.method, required this.url, this.fields});

  static UploadTarget fromJson(Map<String, dynamic> json) => UploadTarget(
    method: json['method'] as String,
    url: json['url'] as String,
    fields: (json['fields'] as Map<String, dynamic>?)?.map(
      (k, v) => MapEntry(k, v as String),
    ),
  );
}

class CreateUploadUrlResponse {
  final String objectKey;
  final UploadTarget target;
  const CreateUploadUrlResponse({
    required this.objectKey,
    required this.target,
  });
  static CreateUploadUrlResponse fromJson(Map<String, dynamic> json) =>
      CreateUploadUrlResponse(
        objectKey: json['objectKey'] as String,
        target: UploadTarget.fromJson(json['target'] as Map<String, dynamic>),
      );
}

/// This is the actual "plaintext" of a `contentTypeHint: 'media'` message: a small
/// JSON blob naming an object-storage key + the AES-256-GCM key/nonce needed to
/// decrypt it — never the file bytes themselves (those live in object storage,
/// encrypted, fetched on demand).
class AttachmentDescriptor {
  final String objectKey;
  final String key; // base64
  final String nonce; // base64
  final String mimeType;
  final String fileName;
  final int sizeBytes;
  const AttachmentDescriptor({
    required this.objectKey,
    required this.key,
    required this.nonce,
    required this.mimeType,
    required this.fileName,
    required this.sizeBytes,
  });

  Map<String, dynamic> toJson() => {
    'objectKey': objectKey,
    'key': key,
    'nonce': nonce,
    'mimeType': mimeType,
    'fileName': fileName,
    'sizeBytes': sizeBytes,
  };
  static AttachmentDescriptor fromJson(Map<String, dynamic> json) =>
      AttachmentDescriptor(
        objectKey: json['objectKey'] as String,
        key: json['key'] as String,
        nonce: json['nonce'] as String,
        mimeType: json['mimeType'] as String,
        fileName: json['fileName'] as String,
        sizeBytes: json['sizeBytes'] as int,
      );
}

class CursorPage<T> {
  final List<T> items;
  final String? nextCursor;
  const CursorPage({required this.items, required this.nextCursor});
  static CursorPage<T> fromJson<T>(
    Map<String, dynamic> json,
    T Function(Map<String, dynamic>) itemFromJson,
  ) => CursorPage<T>(
    items: (json['items'] as List)
        .map((e) => itemFromJson(e as Map<String, dynamic>))
        .toList(),
    nextCursor: json['nextCursor'] as String?,
  );
}

// --- Admin (mirrors packages/types/src/admin.ts) ---------------------------------

class ProvisionedUserSummary {
  final String id;
  final String username;
  final String displayName;
  final String status;
  final String createdAt;
  const ProvisionedUserSummary({
    required this.id,
    required this.username,
    required this.displayName,
    required this.status,
    required this.createdAt,
  });
  static ProvisionedUserSummary fromJson(Map<String, dynamic> json) =>
      ProvisionedUserSummary(
        id: json['id'] as String,
        username: json['username'] as String,
        displayName: json['displayName'] as String,
        status: json['status'] as String,
        createdAt: json['createdAt'] as String,
      );
}

class ProvisionUserResult {
  final String userId;
  final String username;
  final String inviteUrl;
  final String expiresAt;
  const ProvisionUserResult({
    required this.userId,
    required this.username,
    required this.inviteUrl,
    required this.expiresAt,
  });
  static ProvisionUserResult fromJson(Map<String, dynamic> json) =>
      ProvisionUserResult(
        userId: json['userId'] as String,
        username: json['username'] as String,
        inviteUrl: json['inviteUrl'] as String,
        expiresAt: json['expiresAt'] as String,
      );
}
