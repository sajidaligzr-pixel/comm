import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

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
    );
  }
}
