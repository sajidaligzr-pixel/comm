/// Shown for the brief window between app start and `AuthController.bootstrap()`
/// resolving whether this device needs to unlock, log in, or is already signed
/// in — see router.dart's `computeAuthRedirect` docstring for the real bug this
/// closes: without a route that's actually safe to render during `AuthChecking`,
/// the router had nowhere neutral to sit and would briefly show real account
/// content (the chats list — real conversation names, fetched live) before the
/// unlock gate took over. Deliberately fetches/decrypts/renders nothing.
library;

import 'package:flutter/material.dart';

class SplashScreen extends StatelessWidget {
  const SplashScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}
