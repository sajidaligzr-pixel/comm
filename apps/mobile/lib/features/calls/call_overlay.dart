/// Full-screen call UI — the mobile counterpart to
/// `apps/web/components/call/call-overlay.tsx`. Mounted once at the app-shell level
/// (see app/app.dart, and its docstring on why the wrapping `Positioned.fill` there
/// is load-bearing) so an incoming call rings no matter which screen is open, not
/// just while a specific thread is on screen.
///
/// Deliberately dark regardless of the rest of the app being pinned to
/// WhatsAppColors/light theme (app/app.dart) — WhatsApp's own call screen is
/// always dark, independent of the chat list/thread theme, a deliberate
/// "phone call" visual register distinct from browsing chats. This is that same
/// choice, not an inconsistency with the light-only mandate elsewhere.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'call_controller.dart';
import 'call_state.dart';

class _CallColors {
  _CallColors._();
  static const backgroundTop = Color(0xFF0B4A44);
  static const backgroundBottom = Color(0xFF072F2B);
  static const subtleText = Color(0xB3FFFFFF); // white @ 70%
  static const faintText = Color(0x80FFFFFF); // white @ 50%
  static const pillIdle = Color(0x33FFFFFF); // white @ 20% — unmuted/earpiece
  static const pillActive = Colors.white; // muted/speaker-on
  static const danger = Color(0xFFE53935);
  static const accept = Color(0xFF25D366); // WhatsApp green
}

class CallOverlay extends ConsumerWidget {
  const CallOverlay({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final callState = ref.watch(callControllerProvider);
    final controller = ref.read(callControllerProvider.notifier);

    if (callState.phase == CallPhase.idle || callState.call == null) {
      return const SizedBox.shrink();
    }

    final call = callState.call!;
    final ringing =
        callState.phase == CallPhase.outgoing ||
        callState.phase == CallPhase.incoming;

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
                      CircleAvatar(
                        radius: 56,
                        backgroundColor: Colors.white.withValues(alpha: 0.15),
                        child: Text(
                          call.otherDisplayName.isNotEmpty
                              ? call.otherDisplayName[0].toUpperCase()
                              : '?',
                          style: const TextStyle(
                            fontSize: 42,
                            color: Colors.white,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                      ),
                      const SizedBox(height: 20),
                      Text(
                        call.otherDisplayName,
                        style: const TextStyle(
                          fontSize: 24,
                          color: Colors.white,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                      const SizedBox(height: 8),
                      Text(
                        _statusLine(callState),
                        style: const TextStyle(
                          fontSize: 15,
                          color: _CallColors.subtleText,
                        ),
                      ),
                      if (ringing) ...[
                        const SizedBox(height: 6),
                        const Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Icon(
                              Icons.call,
                              size: 14,
                              color: _CallColors.faintText,
                            ),
                            SizedBox(width: 6),
                            Text(
                              'Voice call',
                              style: TextStyle(
                                fontSize: 12,
                                color: _CallColors.faintText,
                              ),
                            ),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
                if (callState.micError != null)
                  _MicErrorBanner(
                    message: callState.micError!,
                    onDismiss: controller.dismissMicError,
                  ),
                _buildControls(callState, controller),
              ],
            ),
          ),
        ),
      ),
    );
  }

  String _statusLine(CallUiState s) {
    if (s.phase == CallPhase.connected) return _formatDuration(s.durationSec);
    return s.statusText;
  }

  String _formatDuration(int totalSeconds) {
    final m = (totalSeconds ~/ 60).toString().padLeft(2, '0');
    final sec = (totalSeconds % 60).toString().padLeft(2, '0');
    return '$m:$sec';
  }

  Widget _buildControls(CallUiState s, CallController controller) {
    switch (s.phase) {
      case CallPhase.incoming:
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _CircleButton(
                icon: Icons.call_end,
                background: _CallColors.danger,
                onPressed: () => controller.rejectCall('declined'),
                label: 'Decline',
                large: true,
              ),
              _CircleButton(
                icon: Icons.call,
                background: _CallColors.accept,
                onPressed: controller.acceptCall,
                label: 'Accept',
                large: true,
              ),
            ],
          ),
        );
      case CallPhase.outgoing:
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: _CircleButton(
            icon: Icons.call_end,
            background: _CallColors.danger,
            onPressed: controller.hangUp,
            label: 'Cancel',
            large: true,
          ),
        );
      case CallPhase.connected:
        // Mute + speaker + end-call — the same three controls a real WhatsApp
        // voice call screen offers once connected. Kept as one evenly-spaced row
        // (not cramped) now that the overlay is genuinely full-screen (see this
        // widget's own docstring and app.dart's Positioned.fill fix).
        return Padding(
          padding: const EdgeInsets.only(bottom: 8),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
            children: [
              _CircleButton(
                icon: s.muted ? Icons.mic_off : Icons.mic,
                background: s.muted
                    ? _CallColors.pillActive
                    : _CallColors.pillIdle,
                iconColor: s.muted ? Colors.black : Colors.white,
                onPressed: controller.toggleMute,
                label: s.muted ? 'Unmute' : 'Mute',
              ),
              _CircleButton(
                icon: Icons.call_end,
                background: _CallColors.danger,
                onPressed: controller.hangUp,
                label: 'End',
                large: true,
              ),
              _CircleButton(
                icon: s.speakerOn ? Icons.volume_up : Icons.volume_off,
                background: s.speakerOn
                    ? _CallColors.pillActive
                    : _CallColors.pillIdle,
                iconColor: s.speakerOn ? Colors.black : Colors.white,
                onPressed: controller.toggleSpeaker,
                label: 'Speaker',
              ),
            ],
          ),
        );
      case CallPhase.ended:
      case CallPhase.idle:
        return const SizedBox(height: 88);
    }
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
  final VoidCallback onPressed;
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
