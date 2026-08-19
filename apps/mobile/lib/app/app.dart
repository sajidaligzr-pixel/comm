import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/calls/call_overlay.dart';
import '../features/calls/group_call_overlay.dart';
import '../features/update/update_prompt.dart';
import 'providers.dart' show realtimeClientProvider;
import 'router.dart';

/// WhatsApp's own palette — asked for directly ("keep the UI same as whatsapp,
/// 100% the same," and explicitly not dark) after the original indigo Material
/// seed color read as unfamiliar. These are WhatsApp's real, well-known hex
/// values applied directly, not a `ColorScheme.fromSeed` derivation — a seeded
/// scheme produces WhatsApp-*adjacent* tones, not the actual ones people
/// recognize.
class WhatsAppColors {
  WhatsAppColors._();
  static const appBar = Color(0xFF075E54); // header / app bar
  static const tealAccent = Color(0xFF128C7E); // buttons, links, focus states
  static const green = Color(0xFF25D366); // FAB / send button / unread badge
  static const outgoingBubble = Color(0xFFDCF8C6); // sent-message bubble
  static const incomingBubble = Color(0xFFFFFFFF); // received-message bubble
  static const chatBackground = Color(
    0xFFECE5DD,
  ); // chat-thread background tone
  static const bubbleText = Color(
    0xFF111B21,
  ); // WhatsApp's near-black bubble text
  static const listBackground = Color(0xFFFFFFFF);
}

class CommApp extends ConsumerStatefulWidget {
  const CommApp({super.key});

  @override
  ConsumerState<CommApp> createState() => _CommAppState();
}

class _CommAppState extends ConsumerState<CommApp> with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// The other half of ws_client.dart's `reconnect` docstring: a backgrounded
  /// phone can silently kill this app's WebSocket without ever telling this
  /// process (no `onDone`/`onError`, nothing to trigger the client's own
  /// reconnect-with-backoff), so coming back to the foreground is the one
  /// reliable moment to force a fresh connection rather than trust whatever
  /// `_channel` currently thinks it's holding. Every open screen listening for
  /// 'connection.open' (chats_list_screen.dart, thread_screen.dart) then resyncs
  /// itself from this, the same as a manual pull-to-refresh would — this is what
  /// actually fixes "messages/read receipts only show up after I reopen the
  /// app," not just future live events.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      ref.read(realtimeClientProvider).reconnect();
    }
  }

  @override
  Widget build(BuildContext context) {
    final router = ref.watch(routerProvider);

    final colorScheme =
        ColorScheme.fromSeed(
          seedColor: WhatsAppColors.tealAccent,
          brightness: Brightness.light,
        ).copyWith(
          primary: WhatsAppColors.tealAccent,
          secondary: WhatsAppColors.green,
          surface: WhatsAppColors.listBackground,
        );

    return MaterialApp.router(
      title: 'Comm',
      debugShowCheckedModeBanner: false,
      // Always light — WhatsApp's own look, asked for explicitly, regardless of the
      // phone's own system dark-mode setting. No darkTheme is registered and
      // themeMode is pinned, so MaterialApp's own default (ThemeMode.system, which
      // WOULD follow the phone into dark mode) never takes effect.
      themeMode: ThemeMode.light,
      theme: ThemeData(
        useMaterial3: true,
        brightness: Brightness.light,
        colorScheme: colorScheme,
        scaffoldBackgroundColor: WhatsAppColors.listBackground,
        appBarTheme: const AppBarTheme(
          backgroundColor: WhatsAppColors.appBar,
          foregroundColor: Colors.white,
          elevation: 0,
          centerTitle: false,
          iconTheme: IconThemeData(color: Colors.white),
          actionsIconTheme: IconThemeData(color: Colors.white),
          titleTextStyle: TextStyle(
            color: Colors.white,
            fontSize: 20,
            fontWeight: FontWeight.w500,
          ),
        ),
        floatingActionButtonTheme: const FloatingActionButtonThemeData(
          backgroundColor: WhatsAppColors.green,
          foregroundColor: Colors.white,
        ),
        iconTheme: const IconThemeData(color: WhatsAppColors.tealAccent),
        progressIndicatorTheme: const ProgressIndicatorThemeData(
          color: WhatsAppColors.tealAccent,
        ),
        textSelectionTheme: const TextSelectionThemeData(
          cursorColor: WhatsAppColors.tealAccent,
          selectionHandleColor: WhatsAppColors.tealAccent,
        ),
        switchTheme: SwitchThemeData(
          thumbColor: WidgetStateProperty.resolveWith(
            (s) =>
                s.contains(WidgetState.selected) ? WhatsAppColors.green : null,
          ),
        ),
      ),
      routerConfig: router,
      // Mounted once, above every route, exactly like CallProvider's placement in
      // apps/web's (app)/layout.tsx — an incoming call has to ring no matter which
      // screen is open, not just while a specific chat thread is on screen.
      // GroupCallOverlay is a SEPARATE, sibling widget (same "mount once, ring
      // anywhere" reasoning) — see group_call_controller.dart's own docstring for
      // why it's not merged into CallOverlay/CallController despite the identical
      // placement; cross-coordination (call_coordination.dart) keeps at most one
      // of the two ever actually active, so stacking both here is safe — the
      // idle one always renders SizedBox.shrink()/an invite banner, never both
      // full-screen at once.
      //
      // Positioned.fill is load-bearing, not decorative: a bare Stack sizes each
      // non-positioned child by its own natural size, and CallOverlay's content
      // (an avatar + a couple of lines of text + a button row, in a Column that
      // defaults to CrossAxisAlignment.center) shrink-wraps to the width of its
      // widest line — found live as the call screen rendering as a narrow column
      // pinned to the left third of the screen with the chat thread still visible
      // through the rest of it. Positioned.fill forces tight, full-screen
      // constraints down through Material → Column regardless of content width.
      builder: (context, child) => Stack(
        children: [
          if (child != null) child,
          const Positioned.fill(child: CallOverlay()),
          const Positioned.fill(child: GroupCallOverlay()),
          // In-app update prompt (features/update/) — last in the Stack (painted on
          // top) so it can't be hidden behind a call overlay; the two are extremely
          // unlikely to coincide in practice (a call in progress vs. app-launch
          // timing), and there's no coordination between them beyond paint order.
          const Positioned.fill(child: UpdatePromptOverlay()),
        ],
      ),
    );
  }
}
