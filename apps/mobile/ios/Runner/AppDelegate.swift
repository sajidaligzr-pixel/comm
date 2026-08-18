import Flutter
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate {
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
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
