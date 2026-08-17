import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'api/api_client.dart';
import 'app/app.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Must resolve before any widget builds — every provider in app/providers.dart
  // reads `ApiClient.instance` synchronously, which throws until this has run (see
  // that class's own guard).
  await ApiClient.initialize();
  runApp(const ProviderScope(child: CommApp()));
}
