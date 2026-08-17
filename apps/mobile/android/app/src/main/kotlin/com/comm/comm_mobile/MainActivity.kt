package com.comm.comm_mobile

// local_auth (features/auth/biometric_unlock.dart) requires the host Activity to be
// a FragmentActivity — its Android implementation shows the OS biometric prompt via
// FragmentManager, and calling authenticate() against a plain FlutterActivity throws
// at runtime the first time it's invoked, not at build time (see local_auth's own
// README, "Activity Changes"). FlutterFragmentActivity is a drop-in replacement for
// FlutterActivity otherwise — nothing else in this app depends on the distinction.
import io.flutter.embedding.android.FlutterFragmentActivity

class MainActivity : FlutterFragmentActivity()
