/// Full-screen call UI — the mobile counterpart to
/// `apps/web/components/call/call-overlay.tsx`. Mounted once at the app-shell level
/// (see app/app.dart) so an incoming call rings no matter which screen is open, not
/// just while a specific thread is on screen.
library;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'call_controller.dart';
import 'call_state.dart';

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
    final scheme = Theme.of(context).colorScheme;

    return Material(
      color: scheme.surface.withValues(alpha: 0.98),
      child: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              const SizedBox(height: 32),
              Column(
                children: [
                  CircleAvatar(
                    radius: 48,
                    child: Text(
                      call.otherDisplayName.isNotEmpty ? call.otherDisplayName[0].toUpperCase() : '?',
                      style: const TextStyle(fontSize: 36),
                    ),
                  ),
                  const SizedBox(height: 16),
                  Text(call.otherDisplayName, style: Theme.of(context).textTheme.headlineSmall),
                  const SizedBox(height: 8),
                  Text(_statusLine(callState), style: Theme.of(context).textTheme.bodyLarge),
                  if (callState.micError != null) ...[
                    const SizedBox(height: 12),
                    Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 24),
                      child: Text(
                        callState.micError!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: scheme.error),
                      ),
                    ),
                    TextButton(onPressed: controller.dismissMicError, child: const Text('Dismiss')),
                  ],
                ],
              ),
              _buildControls(context, callState, controller),
            ],
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

  Widget _buildControls(BuildContext context, CallUiState s, CallController controller) {
    switch (s.phase) {
      case CallPhase.incoming:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _RoundButton(icon: Icons.call_end, color: Colors.red, onPressed: () => controller.rejectCall('declined'), label: 'Decline'),
            _RoundButton(icon: Icons.call, color: Colors.green, onPressed: controller.acceptCall, label: 'Accept'),
          ],
        );
      case CallPhase.outgoing:
        return _RoundButton(icon: Icons.call_end, color: Colors.red, onPressed: controller.hangUp, label: 'Cancel');
      case CallPhase.connected:
        return Row(
          mainAxisAlignment: MainAxisAlignment.spaceEvenly,
          children: [
            _RoundButton(
              icon: s.muted ? Icons.mic_off : Icons.mic,
              color: s.muted ? Colors.white : Colors.white24,
              iconColor: s.muted ? Colors.black : Colors.white,
              onPressed: controller.toggleMute,
              label: s.muted ? 'Unmute' : 'Mute',
              small: true,
            ),
            _RoundButton(icon: Icons.call_end, color: Colors.red, onPressed: controller.hangUp, label: 'End'),
            _RoundButton(
              icon: s.speakerOn ? Icons.volume_up : Icons.volume_off,
              color: s.speakerOn ? Colors.white : Colors.white24,
              iconColor: s.speakerOn ? Colors.black : Colors.white,
              onPressed: controller.toggleSpeaker,
              label: 'Speaker',
              small: true,
            ),
          ],
        );
      case CallPhase.ended:
      case CallPhase.idle:
        return const SizedBox(height: 72);
    }
  }
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({required this.icon, required this.color, required this.onPressed, required this.label, this.iconColor, this.small = false});
  final IconData icon;
  final Color color;
  final Color? iconColor;
  final VoidCallback onPressed;
  final String label;
  final bool small;

  @override
  Widget build(BuildContext context) {
    final size = small ? 52.0 : 64.0;
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        SizedBox(
          width: size,
          height: size,
          child: FloatingActionButton(
            heroTag: label,
            backgroundColor: color,
            onPressed: onPressed,
            child: Icon(icon, color: iconColor ?? Colors.white),
          ),
        ),
        const SizedBox(height: 6),
        Text(label, style: const TextStyle(fontSize: 12)),
      ],
    );
  }
}
