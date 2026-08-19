/// The actual "Update required" UI — a bottom-anchored card over an opaque
/// scrim, not a real `showModalBottomSheet`/route: this widget is mounted once
/// at the app-shell level (app/app.dart, same placement as CallOverlay/
/// GroupCallOverlay) specifically so an update can be offered no matter which
/// screen is open, including before the user has ever logged in — and a modal
/// route needs a `Navigator` above the calling context, which `MaterialApp.router`'s
/// own `builder` callback isn't guaranteed to have yet. Rendering the "modal" look
/// directly in this Stack (mirrors GroupCallOverlay's own `_InviteBanner`, the
/// identical problem solved the identical way) sidesteps that entirely.
///
/// Mandatory: once `_check()` finds a newer build, there is no way out of this
/// screen short of actually updating. No "Not now", no tap-outside-to-dismiss,
/// no back-button escape needed — the full-screen `Container` scrim has no
/// `onTap` at all, so it simply sits there and swallows every touch that would
/// otherwise reach whatever's underneath (a plain opaque widget still wins
/// hit-testing regardless of whether it has a gesture handler). The only buttons
/// on the card are "Update" and, if the download/install itself fails, "Retry".
library;

import 'package:flutter/material.dart';

import 'update_models.dart';
import 'update_service.dart';

enum _Phase { hidden, blocking, downloading, error }

class UpdatePromptOverlay extends StatefulWidget {
  const UpdatePromptOverlay({super.key});

  @override
  State<UpdatePromptOverlay> createState() => _UpdatePromptOverlayState();
}

class _UpdatePromptOverlayState extends State<UpdatePromptOverlay> {
  _Phase _phase = _Phase.hidden;
  AppVersionInfo? _info;
  double _progress = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    // One check per cold start — not on every resume/reconnect the way call
    // catch-up is, since this is genuinely a low-frequency thing (a new build
    // isn't cut more than a few times a week at most) and re-checking constantly
    // would just be wasted requests for the same answer.
    WidgetsBinding.instance.addPostFrameCallback((_) => _check());
  }

  Future<void> _check() async {
    final result = await checkForUpdate();
    if (!mounted || result == null) return;
    setState(() {
      _info = result.info;
      _phase = _Phase.blocking;
    });
  }

  Future<void> _update() async {
    final info = _info;
    if (info == null) return;
    setState(() {
      _phase = _Phase.downloading;
      _progress = 0;
    });
    try {
      await downloadAndInstall(info.apkUrl, info.buildNumber, (p) {
        if (mounted) setState(() => _progress = p);
      });
      // Android's package installer takes over the screen from here. Stay in
      // `downloading` rather than dropping back to `hidden` — this build is
      // still the old, blocked one until the install actually completes and the
      // process restarts; hiding the card here would let the old app show
      // through underneath while the installer is still up.
    } catch (_) {
      if (mounted) {
        setState(() {
          _phase = _Phase.error;
          _error = 'Could not download the update. Check your connection and try again.';
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_phase == _Phase.hidden || _info == null) return const SizedBox.shrink();
    final info = _info!;

    return Stack(
      children: [
        // Opaque, not just dimmed — this is the actual block, not decoration.
        // Deliberately no `onTap`: nothing short of updating dismisses this.
        const Positioned.fill(
          child: ColoredBox(color: Colors.black87),
        ),
        Align(
          alignment: Alignment.bottomCenter,
          child: SafeArea(
            top: false,
            child: Material(
              color: Theme.of(context).colorScheme.surface,
              borderRadius: const BorderRadius.vertical(top: Radius.circular(20)),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(20, 20, 20, 24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        const Icon(Icons.system_update, size: 22),
                        const SizedBox(width: 10),
                        Expanded(
                          child: Text(
                            'Update required',
                            style: Theme.of(context).textTheme.titleMedium?.copyWith(fontWeight: FontWeight.w600),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 6),
                    Text(
                      'Version ${info.versionName} is required to keep using Comm.',
                      style: Theme.of(context).textTheme.bodyMedium,
                    ),
                    if (info.releaseNotes != null && info.releaseNotes!.trim().isNotEmpty) ...[
                      const SizedBox(height: 8),
                      Text(
                        info.releaseNotes!,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: Theme.of(context).colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                    const SizedBox(height: 16),
                    if (_phase == _Phase.downloading) ...[
                      LinearProgressIndicator(value: _progress > 0 ? _progress : null),
                      const SizedBox(height: 8),
                      Text(
                        _progress > 0 ? 'Downloading… ${(_progress * 100).round()}%' : 'Downloading…',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ] else ...[
                      if (_phase == _Phase.error && _error != null) ...[
                        Text(_error!, style: TextStyle(color: Theme.of(context).colorScheme.error, fontSize: 13)),
                        const SizedBox(height: 12),
                      ],
                      Row(
                        mainAxisAlignment: MainAxisAlignment.end,
                        children: [
                          FilledButton(onPressed: _update, child: Text(_phase == _Phase.error ? 'Retry' : 'Update')),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ),
        ),
      ],
    );
  }
}
