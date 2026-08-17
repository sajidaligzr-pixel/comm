import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../features/calls/call_overlay.dart';
import 'router.dart';

class CommApp extends ConsumerWidget {
  const CommApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final router = ref.watch(routerProvider);
    final seed = const Color(0xFF4F46E5); // matches apps/web's primary accent

    return MaterialApp.router(
      title: 'Comm',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed), useMaterial3: true),
      darkTheme: ThemeData(colorScheme: ColorScheme.fromSeed(seedColor: seed, brightness: Brightness.dark), useMaterial3: true),
      routerConfig: router,
      // Mounted once, above every route, exactly like CallProvider's placement in
      // apps/web's (app)/layout.tsx — an incoming call has to ring no matter which
      // screen is open, not just while a specific chat thread is on screen.
      builder: (context, child) => Stack(children: [if (child != null) child, const CallOverlay()]),
    );
  }
}
