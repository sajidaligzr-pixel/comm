/// A single, WhatsApp-styled "something went wrong" view — every full-screen
/// load (thread, chats list, admin, devices, group info) used to just dump the
/// raw server/exception message as bare, unstyled `Center(child: Text(...))`
/// with no icon and no way to recover short of leaving the screen. That's what
/// this replaces everywhere: one shared, deliberately designed error state with
/// an icon, readable copy, and — wherever the caller has something to re-run —
/// a "Try again" button, so a real failure (or a validation message that leaked
/// through, see thread_screen.dart's own fix alongside this) never again reads
/// like a crash log.
library;

import 'package:flutter/material.dart';
import '../../app/app.dart' show WhatsAppColors;

class ErrorState extends StatelessWidget {
  const ErrorState({super.key, required this.message, this.onRetry});

  /// Shown as the body copy. Server validation messages (`AppError`'s
  /// `VALIDATION_FAILED` text) are written to be end-user-safe already — see
  /// apps/web/server/common/validate.ts's docstring — so no further rewriting
  /// happens here, only presentation.
  final String message;

  /// Re-runs whatever load failed. Omit for a context with nothing sensible to
  /// retry (there isn't one today, but the option is here for callers that need
  /// a plain, non-actionable error state).
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(
                color: WhatsAppColors.tealAccent.withValues(alpha: 0.1),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.error_outline_rounded, size: 32, color: WhatsAppColors.tealAccent),
            ),
            const SizedBox(height: 16),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15, color: Color(0xFF667781), height: 1.4),
            ),
            if (onRetry != null) ...[
              const SizedBox(height: 20),
              FilledButton.icon(
                onPressed: onRetry,
                style: FilledButton.styleFrom(backgroundColor: WhatsAppColors.tealAccent, foregroundColor: Colors.white),
                icon: const Icon(Icons.refresh, size: 18),
                label: const Text('Try again'),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

/// A softer, non-error empty state (e.g. "no conversations yet") — same visual
/// language as [ErrorState] (icon in a tinted circle + centered copy) but with a
/// neutral icon/tone, since "you have no chats" isn't a failure.
class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.message});
  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(32),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 64,
              height: 64,
              decoration: BoxDecoration(color: WhatsAppColors.tealAccent.withValues(alpha: 0.08), shape: BoxShape.circle),
              child: Icon(icon, size: 32, color: WhatsAppColors.tealAccent.withValues(alpha: 0.7)),
            ),
            const SizedBox(height: 16),
            Text(
              message,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 15, color: Color(0xFF667781), height: 1.4),
            ),
          ],
        ),
      ),
    );
  }
}
