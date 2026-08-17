library;

import 'api_client.dart';
import 'dtos.dart';

class GroupsApi {
  const GroupsApi(this._client);
  final ApiClient _client;

  Future<GroupSummary> create(String name, List<String> memberUsernames, {String? description}) {
    return _client.request(
      '/api/groups',
      body: {'name': name, if (description != null) 'description': description, 'memberUsernames': memberUsernames},
      parse: (data) => GroupSummary.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<GroupSummary> get(String groupId) {
    return _client.request('/api/groups/$groupId', method: 'GET', parse: (data) => GroupSummary.fromJson(data as Map<String, dynamic>));
  }

  Future<GroupSummary> update(String groupId, {String? name, String? description, bool? onlyAdminsCanMessage}) {
    return _client.request(
      '/api/groups/$groupId',
      method: 'PATCH',
      body: {
        if (name != null) 'name': name,
        if (description != null) 'description': description,
        if (onlyAdminsCanMessage != null) 'onlyAdminsCanMessage': onlyAdminsCanMessage,
      },
      parse: (data) => GroupSummary.fromJson(data as Map<String, dynamic>),
    );
  }

  Future<void> addMember(String groupId, String username) {
    return _client.requestVoid('/api/groups/$groupId/members', body: {'username': username});
  }

  Future<void> removeMember(String groupId, String userId) {
    return _client.requestVoid('/api/groups/$groupId/members/$userId', method: 'DELETE');
  }

  Future<List<GroupMemberTarget>> memberDevices(String groupId) {
    return _client.request(
      '/api/groups/$groupId/member-devices',
      method: 'GET',
      parse: (data) => (data as List).map((e) => GroupMemberTarget.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  Future<List<GroupKeyShareDto>> listKeyShares(String groupId) {
    return _client.request(
      '/api/groups/$groupId/key-shares',
      method: 'GET',
      parse: (data) => (data as List).map((e) => GroupKeyShareDto.fromJson(e as Map<String, dynamic>)).toList(),
    );
  }

  /// The PRIMARY path for sending a key-share (not just a fallback) — guarantees the
  /// durable `GroupKeyShare` row exists regardless of WS socket timing, mirroring
  /// `apps/web/components/group/group-session-provider.tsx#shareSessionTo`'s own
  /// comment on why this is REST, not a fire-and-forget WS send.
  Future<void> sendKeyShare(String groupId, int epoch, String toDeviceId, MessageEnvelopeUpload envelope, X3dhInitPayload? x3dhInit) {
    return _client.requestVoid(
      '/api/groups/$groupId/key-shares',
      body: {
        'groupId': groupId,
        'epoch': epoch,
        'toDeviceId': toDeviceId,
        'envelope': envelope.toJson(),
        'x3dhInit': x3dhInit?.toJson(),
      },
    );
  }
}
