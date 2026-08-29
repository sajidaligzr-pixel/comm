import Flutter
import UIKit
import UserNotifications
import PushKit
import CallKit
import AVFAudio
import flutter_callkit_incoming

@main
@objc class AppDelegate: FlutterAppDelegate, PKPushRegistryDelegate, CallkitIncomingAppDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    GeneratedPluginRegistrant.register(with: self)
    // Required by flutter_local_notifications (features/notifications/) for iOS
    // 10+ — without this, notification taps/foreground presentation don't route
    // back into the plugin correctly. Not optional general setup, per the
    // plugin's own README, distinct from the separate (and NOT needed here)
    // action-button background-isolate wiring.
    if #available(iOS 10.0, *) {
      UNUserNotificationCenter.current().delegate = self as? UNUserNotificationCenterDelegate
    }

    // PushKit/CallKit (features/calls/call_kit.dart's own docstring, docs/13-roadmap.md's
    // iOS closed-app-ringing pass) — the one thing a plain remote-notification/local
    // notification structurally cannot do: ring / show the native lock-screen call
    // UI while this app is fully closed, not just backgrounded. Apple requires an
    // app that registers for VoIP pushes to report every single one to CallKit
    // synchronously (see didReceiveIncomingPushWith below) — it terminates apps
    // that register but don't, so this is not optional once desiredPushTypes
    // includes .voIP; there's no way to "opt out" partway through receiving one.
    let voipRegistry = PKPushRegistry(queue: .main)
    voipRegistry.delegate = self
    voipRegistry.desiredPushTypes = [.voIP]

    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  // New VoIP push token (first launch, or Apple rotating it) — forwarded to Dart
  // via the plugin's own event stream (Event.actionDidUpdateDevicePushTokenVoip,
  // call_kit.dart) so it can be uploaded to this app's own server
  // (POST /api/push/voip-token) the same way the regular FCM token already is
  // (push_notifications.dart).
  func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
    let token = credentials.token.map { String(format: "%02x", $0) }.joined()
    SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP(token)
  }

  func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
    SwiftFlutterCallkitIncomingPlugin.sharedInstance?.setDevicePushTokenVoIP("")
  }

  // The actual incoming call. apps/worker's handleCallRing (push-dispatch.ts)
  // sends `id`/`nameCaller`/`handle`/`isVideo` as top-level payload keys (this app
  // has no video calling, so isVideo is always false) plus `extra.conversationId` —
  // the same payload shape showIncomingCall already sends on Android
  // (call_kit.dart), just delivered over a different transport per platform.
  func pushRegistry(
    _ registry: PKPushRegistry,
    didReceiveIncomingPushWith payload: PKPushPayload,
    for type: PKPushType,
    completion: @escaping () -> Void
  ) {
    guard type == .voIP else {
      completion()
      return
    }
    let id = payload.dictionaryPayload["id"] as? String ?? UUID().uuidString
    let nameCaller = payload.dictionaryPayload["nameCaller"] as? String ?? "Unknown"
    let handle = payload.dictionaryPayload["handle"] as? String ?? ""
    let data = flutter_callkit_incoming.Data(id: id, nameCaller: nameCaller, handle: handle, type: 0)
    if let extra = payload.dictionaryPayload["extra"] as? [String: Any] {
      data.extra = extra as NSDictionary
    }
    SwiftFlutterCallkitIncomingPlugin.sharedInstance?.showCallkitIncoming(data, fromPushKit: true) {
      completion()
    }
  }

  // Real Accept/Decline/End handling stays in Dart — call_kit.dart's existing
  // FlutterCallkitIncoming.onEvent listener (the same one Android already uses,
  // now un-gated for iOS too) picks these up the moment Flutter is running, which
  // CallKit answering a call always guarantees (it brings this app to the
  // foreground per Apple's own design). These three just fulfill the native
  // action immediately, which CallKit requires regardless of what handles the
  // actual business logic.
  func onAccept(_ call: Call, _ action: CXAnswerCallAction) {
    action.fulfill()
  }

  func onDecline(_ call: Call, _ action: CXEndCallAction) {
    action.fulfill()
  }

  func onEnd(_ call: Call, _ action: CXEndCallAction) {
    action.fulfill()
  }

  func onTimeOut(_ call: Call) {
    // No native action to fulfill for a timeout — CallController's own ring timer
    // (call_controller.dart) is what actually resolves this call server-side.
  }

  // New required protocol member as of flutter_callkit_incoming 3.x (previously
  // 2.5.8 had no such requirement) — CXProviderDelegate's own reset callback,
  // fired if the system invalidates the whole CXProvider (e.g. Springboard
  // restarting CallKit). No native action to fulfill here either, same reasoning
  // as onTimeOut above: there's nothing call-specific to acknowledge, and
  // CallController's own state (backed by the WS/push signaling, not this
  // provider) is what actually tracks a call's real lifecycle.
  func providerDidReset() {}

  // This app doesn't opt into flutter_webrtc's manual-audio mode (no
  // RTCAudioSession.useManualAudio call anywhere in call_controller.dart) — it
  // lets CallKit manage the shared AVAudioSession and WebRTC's own audio session
  // observer respond to that passively, the simpler of the two documented
  // integration modes and the correct default absent a specific reason for the
  // manual one. Nothing to actively bridge here as a result.
  func didActivateAudioSession(_ audioSession: AVAudioSession) {}

  func didDeactivateAudioSession(_ audioSession: AVAudioSession) {}
}
