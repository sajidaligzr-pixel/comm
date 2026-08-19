/// Full-screen group-call UI — mobile counterpart to
/// `apps/web/components/call/group-call-overlay.tsx`, and parallel to
/// `call_overlay.dart` (1:1) but a tile grid instead of a single remote face.
/// Mounted once at the app-shell level (app/app.dart) alongside `CallOverlay` and
/// the incoming-invite banner below, same "ring no matter which screen is open"
/// reasoning.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'group_call_controller.dart';
import 'group_call_state.dart';

class _CallColors {
  _CallColors._();
  static const backgroundTop = Color(0xFF0B4A44);
  static const backgroundBottom = Color(0xFF072F2B);
  static const subtleText = Color(0xB3FFFFFF);
  static const pillIdle = Color(0x33FFFFFF);
  static const pillActive = Colors.white;
  static const danger = Color(0xFFE53935);
  static const pending = Color(0xFFFBC02D);
}

class GroupCallOverlay extends ConsumerWidget {
  const GroupCallOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final callState = ref.watch(groupCallControllerProvider);
    final controller = ref.read(groupCallControllerProvider.notifier);

    if (callState.phase == GroupCallPhase.idle) {
      return callState.invite != null
          ? _InviteBanner(invite: callState.invite!, controller: controller)
          : const SizedBox.shrink();
    }
    final call = callState.call;
    if (call == null) return const SizedBox.shrink();

    return Material(
      color: Colors.transparent,
      child: DecoratedBox(
        decoration: const BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topCenter,
            end: Alignment.bottomCenter,
            colors: [_CallColors.backgroundTop, _CallColors.backgroundBottom],
          ),
        ),
        child: SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 32),
            child: Column(
              children: [
                Expanded(
                  child: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    children: [
                      Text(
                        call.groupName,
                        textAlign: TextAlign.center,
                        style: const TextStyle(
                          fontSize: 22,
                          color: Colors.white,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 6),
                      Text(
                        callState.statusText,
                        style: const TextStyle(
                          fontSize: 14,
                          color: _CallColors.subtleText,
                        ),
                      ),
                      const SizedBox(height: 24),
                      if (callState.participants.isEmpty)
                        const Text(
                          'Waiting for others to join…',
                          style: TextStyle(
                            fontSize: 13,
                            color: _CallColors.subtleText,
                          ),
                        )
                      else
                        Wrap(
                          spacing: 20,
                          runSpacing: 16,
                          alignment: WrapAlignment.center,
                          children: callState.participants
                              .map((p) => _ParticipantTile(participant: p))
                              .toList(),
                        ),
                    ],
                  ),
                ),
                if (callState.micError != null)
                  _MicErrorBanner(
                    message: callState.micError!,
                    onDismiss: controller.dismissMicError,
                  ),
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [
                      _CircleButton(
                        icon: callState.muted ? Icons.mic_off : Icons.mic,
                        background: callState.muted
                            ? _CallColors.pillActive
                            : _CallColors.pillIdle,
                        iconColor: callState.muted
                            ? Colors.black
                            : Colors.white,
                        onPressed: controller.toggleMute,
                        label: callState.muted ? 'Unmute' : 'Mute',
                      ),
                      _CircleButton(
                        icon: Icons.call_end,
                        background: _CallColors.danger,
                        onPressed: callState.phase == GroupCallPhase.ended
                            ? null
                            : controller.hangUp,
                        label: 'Leave',
                        large: true,
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ParticipantTile extends StatelessWidget {
  const _ParticipantTile({required this.participant});
  final GroupCallParticipantTile participant;

  @override
  Widget build(BuildContext context) {
    final connected = participant.connectionState == 'connected';
    return SizedBox(
      width: 72,
      child: Column(
        children: [
          Stack(
            children: [
              CircleAvatar(
                radius: 28,
                backgroundColor: Colors.white.withValues(alpha: 0.15),
                child: Text(
                  participant.displayName.isNotEmpty
                      ? participant.displayName[0].toUpperCase()
                      : '?',
                  style: const TextStyle(
                    fontSize: 20,
                    color: Colors.white,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              if (!connected)
                Positioned(
                  right: 0,
                  bottom: 0,
                  child: Container(
                    width: 12,
                    height: 12,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: _CallColors.pending,
                      border: Border.all(
                        color: _CallColors.backgroundBottom,
                        width: 2,
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Text(
            participant.displayName,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 11, color: Colors.white),
          ),
        ],
      ),
    );
  }
}

/// A lightweight top banner for an incoming group-call invite, distinct from
/// `CallOverlay`'s full-screen incoming state — a group call has no per-invitee
/// ring the way 1:1 does (see call_coordination.dart's docstring), so this reads
/// as "there's an ongoing call you can join," not "someone is calling you."
class _InviteBanner extends StatelessWidget {
  const _InviteBanner({required this.invite, required this.controller});
  final GroupCallInvite invite;
  final GroupCallController controller;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Align(
        alignment: Alignment.topCenter,
        child: Container(
          margin: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
          decoration: BoxDecoration(
            color: Theme.of(context).colorScheme.surface,
            borderRadius: BorderRadius.circular(16),
            boxShadow: [
              BoxShadow(
                color: Colors.black.withValues(alpha: 0.2),
                blurRadius: 12,
                offset: const Offset(0, 4),
              ),
            ],
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      '${invite.fromDisplayName} started a group call',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(fontWeight: FontWeight.w500),
                    ),
                    Text(
                      invite.groupName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        fontSize: 12,
                        color: Theme.of(context).colorScheme.onSurfaceVariant,
                      ),
                    ),
                  ],
                ),
              ),
              TextButton(
                onPressed: controller.declineInvite,
                child: const Text('Dismiss'),
              ),
              FilledButton(
                onPressed: controller.acceptInvite,
                child: const Text('Join'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MicErrorBanner extends StatelessWidget {
  const _MicErrorBanner({required this.message, required this.onDismiss});
  final String message;
  final VoidCallback onDismiss;

  @override
  Widget build(BuildContext context) {
    return Container(
      margin: const EdgeInsets.only(bottom: 16),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
      decoration: BoxDecoration(
        color: _CallColors.danger.withValues(alpha: 0.16),
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: _CallColors.danger.withValues(alpha: 0.4)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              message,
              style: const TextStyle(color: Colors.white, fontSize: 13),
            ),
          ),
          const SizedBox(width: 8),
          InkWell(
            onTap: onDismiss,
            child: const Icon(Icons.close, size: 18, color: Colors.white),
          ),
        ],
      ),
    );
  }
}

class _CircleButton extends StatelessWidget {
  const _CircleButton({
    required this.icon,
    required this.background,
    required this.onPressed,
    required this.label,
    this.iconColor = Colors.white,
    this.large = false,
  });
  final IconData icon;
  final Color background;
  final Color iconColor;
  final VoidCallback? onPressed;
  final String label;
  final bool large;

  @override
  Widget build(BuildContext context) {
    final size = large ? 68.0 : 56.0;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Material(
          color: background,
          shape: const CircleBorder(),
          child: InkWell(
            customBorder: const CircleBorder(),
            onTap: onPressed,
            child: SizedBox(
              width: size,
              height: size,
              child: Icon(icon, color: iconColor, size: large ? 30 : 24),
            ),
          ),
        ),
        const SizedBox(height: 8),
        Text(label, style: const TextStyle(fontSize: 12, color: Colors.white)),
      ],
    );
  }
}
