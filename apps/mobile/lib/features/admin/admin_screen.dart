/// Account provisioning + suspension — the mobile counterpart to
/// `apps/web`'s `(app)/admin/page.tsx` + `provision-user-form.tsx`. Provisioning is
/// the only way an account comes into existence at all
/// (docs/07-auth-architecture.md): an admin sets a username/display name only, never
/// a password — the invitee chooses their own when they redeem the invite link, so
/// it's never known to the admin or stored anywhere in plaintext.
///
/// Reachable only from a nav entry that's itself gated on a successful
/// `adminApi.listUsers()` call (see chats_list_screen.dart) — but exactly like the
/// web client's own `isAdmin()`, that's a UI convenience, not the real
/// authorization boundary. Every route this screen calls re-derives the admin role
/// server-side via `requireAdmin`, so this screen also handles landing here without
/// admin rights gracefully (a stale nav state, a deep link) rather than assuming
/// its own reachability implies authorization.
library;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show Clipboard, ClipboardData;
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../shared/widgets/error_state.dart';

class AdminScreen extends ConsumerStatefulWidget {
  const AdminScreen({super.key});
  @override
  ConsumerState<AdminScreen> createState() => _AdminScreenState();
}

class _AdminScreenState extends ConsumerState<AdminScreen> {
  List<ProvisionedUserSummary>? _users;
  String? _error;
  bool _forbidden = false;

  final _usernameController = TextEditingController();
  final _displayNameController = TextEditingController();
  bool _creating = false;
  String? _createError;
  ProvisionUserResult? _lastCreated;

  // --- Location access (docs/09-trust-boundaries.md's "Live location sharing"
  // exception) — grant/revoke the LocationViewer privilege, mirroring the
  // account-provisioning section's own list+form shape exactly.
  List<LocationViewerDto>? _viewers;
  String? _viewersError;
  final _grantUsernameController = TextEditingController();
  bool _granting = false;
  String? _grantError;

  @override
  void initState() {
    super.initState();
    _load();
    _loadViewers();
  }

  @override
  void dispose() {
    _usernameController.dispose();
    _displayNameController.dispose();
    _grantUsernameController.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final users = await ref.read(adminApiProvider).listUsers();
      if (mounted) {
        setState(() {
          _users = users;
          _error = null;
          _forbidden = false;
        });
      }
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _forbidden = e.code == 'FORBIDDEN';
        _error = _forbidden ? null : e.message;
      });
    }
  }

  Future<void> _createUser() async {
    final username = _usernameController.text.trim();
    final displayName = _displayNameController.text.trim();
    if (username.isEmpty || displayName.isEmpty) return;

    setState(() {
      _creating = true;
      _createError = null;
    });
    try {
      final result = await ref.read(adminApiProvider).provisionUser(username: username, displayName: displayName);
      _usernameController.clear();
      _displayNameController.clear();
      if (mounted) setState(() => _lastCreated = result);
      await _load();
    } on ApiException catch (e) {
      setState(() => _createError = e.message);
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  Future<void> _loadViewers() async {
    try {
      final viewers = await ref.read(locationsApiProvider).listViewers();
      if (mounted) setState(() => _viewers = viewers);
    } on ApiException catch (e) {
      // A non-admin landing here at all is already handled by `_forbidden` above
      // (this call only runs alongside that one) — just surface the message.
      if (mounted) setState(() => _viewersError = e.message);
    }
  }

  Future<void> _grantViewer() async {
    final username = _grantUsernameController.text.trim();
    if (username.isEmpty) return;
    setState(() {
      _granting = true;
      _grantError = null;
    });
    try {
      await ref.read(locationsApiProvider).grantViewer(username);
      _grantUsernameController.clear();
      await _loadViewers();
    } on ApiException catch (e) {
      setState(() => _grantError = e.message);
    } finally {
      if (mounted) setState(() => _granting = false);
    }
  }

  Future<void> _revokeViewer(LocationViewerDto viewer) async {
    try {
      await ref.read(locationsApiProvider).revokeViewer(viewer.userId);
      await _loadViewers();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  Future<void> _suspend(ProvisionedUserSummary user) async {
    final reason = await showDialog<String>(
      context: context,
      builder: (context) {
        final controller = TextEditingController();
        return AlertDialog(
          title: Text('Suspend @${user.username}?'),
          content: TextField(
            controller: controller,
            decoration: const InputDecoration(labelText: 'Reason', hintText: 'Required — kept in the audit log'),
            autofocus: true,
          ),
          actions: [
            TextButton(onPressed: () => Navigator.of(context).pop(), child: const Text('Cancel')),
            FilledButton(
              style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
              onPressed: () => Navigator.of(context).pop(controller.text.trim()),
              child: const Text('Suspend'),
            ),
          ],
        );
      },
    );
    if (reason == null || reason.isEmpty || !mounted) return;

    try {
      await ref.read(adminApiProvider).suspendUser(user.id, reason);
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  /// Confirmed via a dialog, not a bare button — meaningfully more destructive/
  /// irreversible than suspending (see AdminApi.deleteUser's own docstring).
  Future<void> _delete(ProvisionedUserSummary user) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text('Delete @${user.username}?'),
        content: Text(
          "This permanently deletes @${user.username}'s account. Every direct conversation "
          "they're part of is deleted entirely for everyone in it, and their own messages "
          "inside any group they belong to are removed too. Groups themselves, and other "
          "members' own messages in them, are left alone. This can't be undone.",
        ),
        actions: [
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Cancel')),
          FilledButton(
            style: FilledButton.styleFrom(backgroundColor: Theme.of(context).colorScheme.error),
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Delete'),
          ),
        ],
      ),
    );
    if (confirmed != true || !mounted) return;

    try {
      await ref.read(adminApiProvider).deleteUser(user.id);
      await _load();
    } on ApiException catch (e) {
      if (mounted) ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(e.message)));
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Admin')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_forbidden) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('You do not have permission to view this.', textAlign: TextAlign.center),
        ),
      );
    }
    if (_error != null) return ErrorState(message: _error!, onRetry: _load);
    final users = _users;
    if (users == null) return const Center(child: CircularProgressIndicator());

    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        padding: const EdgeInsets.all(16),
        children: [
          Text(
            'Account provisioning, plus live location sharing — nothing here can read a '
            'user\'s message content (docs/09-trust-boundaries.md documents live location '
            'as this app\'s one explicit exception to that).',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          const SizedBox(height: 12),
          _buildCreateCard(context),
          const SizedBox(height: 24),
          Text('All accounts', style: Theme.of(context).textTheme.titleSmall),
          const SizedBox(height: 8),
          ...users.map((u) => _buildUserCard(context, u)),
          const SizedBox(height: 24),
          _buildLocationAccessSection(context),
        ],
      ),
    );
  }

  Widget _buildCreateCard(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            const Text('Create a user', style: TextStyle(fontWeight: FontWeight.w600)),
            const SizedBox(height: 4),
            Text(
              'You set the username and name only — the invitee chooses their own password when they redeem '
              'the invite link.',
              style: Theme.of(context).textTheme.bodySmall,
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _usernameController,
              decoration: const InputDecoration(labelText: 'Username'),
              autocorrect: false,
              enabled: !_creating,
            ),
            const SizedBox(height: 8),
            TextField(
              controller: _displayNameController,
              decoration: const InputDecoration(labelText: 'Display name'),
              enabled: !_creating,
              onSubmitted: (_) => _createUser(),
            ),
            if (_createError != null) ...[
              const SizedBox(height: 8),
              Text(_createError!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
            ],
            const SizedBox(height: 12),
            FilledButton(
              onPressed: _creating ? null : _createUser,
              child: _creating
                  ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                  : const Text('Create invite'),
            ),
            if (_lastCreated != null) ...[
              const SizedBox(height: 12),
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: Theme.of(context).colorScheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Invite for @${_lastCreated!.username} — share this link with them:', style: Theme.of(context).textTheme.bodySmall),
                    const SizedBox(height: 4),
                    Row(
                      children: [
                        Expanded(
                          child: SelectableText(_lastCreated!.inviteUrl, style: const TextStyle(fontFamily: 'monospace', fontSize: 12)),
                        ),
                        IconButton(
                          icon: const Icon(Icons.copy, size: 18),
                          tooltip: 'Copy',
                          onPressed: () {
                            Clipboard.setData(ClipboardData(text: _lastCreated!.inviteUrl));
                            ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('Invite link copied')));
                          },
                        ),
                      ],
                    ),
                    Text(
                      'Expires ${DateTime.tryParse(_lastCreated!.expiresAt)?.toLocal().toString() ?? _lastCreated!.expiresAt}.',
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _buildUserCard(BuildContext context, ProvisionedUserSummary u) {
    final suspended = u.status == 'suspended';
    final deleted = u.status == 'deleted';
    return Card(
      margin: const EdgeInsets.only(bottom: 8),
      child: ListTile(
        title: Text('${u.displayName}  ·  @${u.username}'),
        subtitle: Text('${u.status} · created ${DateTime.tryParse(u.createdAt)?.toLocal().toString().split('.').first ?? u.createdAt}'),
        trailing: deleted
            ? const Chip(label: Text('deleted', style: TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact)
            : Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (suspended)
                    const Chip(label: Text('suspended', style: TextStyle(fontSize: 11)), visualDensity: VisualDensity.compact)
                  else
                    TextButton(onPressed: () => _suspend(u), child: const Text('Suspend')),
                  TextButton(
                    onPressed: () => _delete(u),
                    style: TextButton.styleFrom(foregroundColor: Theme.of(context).colorScheme.error),
                    child: const Text('Delete'),
                  ),
                ],
              ),
      ),
    );
  }

  /// Grant/revoke the LocationViewer privilege — every admin (this screen's own
  /// audience) can already see everyone's live location by construction; this is
  /// only for extending that to an ordinary user without making them an admin.
  Widget _buildLocationAccessSection(BuildContext context) {
    final viewers = _viewers;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Text('Location access', style: Theme.of(context).textTheme.titleSmall),
        const SizedBox(height: 4),
        Text(
          'Every admin can already see everyone\'s live location. Granting this to an '
          'ordinary user lets them see it too, without giving them any other admin power.',
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: 8),
        Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: TextField(
                    controller: _grantUsernameController,
                    decoration: const InputDecoration(labelText: 'Username'),
                    autocorrect: false,
                    enabled: !_granting,
                    onSubmitted: (_) => _grantViewer(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _granting ? null : _grantViewer,
                  child: _granting
                      ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                      : const Text('Grant'),
                ),
              ],
            ),
          ),
        ),
        if (_grantError != null) ...[
          const SizedBox(height: 4),
          Text(_grantError!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12)),
        ],
        const SizedBox(height: 12),
        if (_viewersError != null)
          Text(_viewersError!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 12))
        else if (viewers == null)
          const Padding(padding: EdgeInsets.symmetric(vertical: 8), child: LinearProgressIndicator())
        else if (viewers.isEmpty)
          Text('No one has been granted location access yet.', style: Theme.of(context).textTheme.bodySmall)
        else
          ...viewers.map(
            (v) => Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: ListTile(
                title: Text('${v.displayName}  ·  @${v.username}'),
                subtitle: Text('Granted ${DateTime.tryParse(v.grantedAt)?.toLocal().toString().split('.').first ?? v.grantedAt}'),
                trailing: TextButton(onPressed: () => _revokeViewer(v), child: const Text('Revoke')),
              ),
            ),
          ),
      ],
    );
  }
}
