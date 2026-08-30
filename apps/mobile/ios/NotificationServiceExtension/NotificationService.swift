import UserNotifications

/// Notification Service Extension — the one thing that fixes what real-device
/// testing found `alert`/`content-available` alone couldn't: iOS only invokes the
/// MAIN app's own background handler while it's still eligible for background
/// execution, and it is NEVER eligible once the user has force-quit it — no
/// exception for `mutable-content`, `content-available`, or any other payload
/// shape. Apple grants THIS extension a separate, brief (~30s) guaranteed
/// wake-up for any push carrying `mutable-content: 1`, independent of the main
/// app's own eligibility — a different process, a different sandbox, no shared
/// Keychain/cookie jar with Runner. That last part is exactly why the delivered-
/// ack here can't just reuse the main app's authenticated session: it doesn't
/// have one. `apps/worker/src/realtime/push-dispatch.ts`'s `createPushDeliveryToken`
/// solves that by minting a one-time, single-use token scoped to this exact
/// message+device pair and riding it along in the payload's own `data` — this
/// extension's whole job is just to redeem it.
///
/// Deliberately does NOT modify the notification's displayed title/body/sound —
/// this app has no need for the "decrypt-then-rewrite-content" use case Apple's
/// own docs lead with; the alert content the server sent is already exactly what
/// should show. The redemption POST is a pure side effect, fired and (best-effort)
/// awaited before handing the untouched content back.
class NotificationService: UNNotificationServiceExtension {
  var contentHandler: ((UNNotificationContent) -> Void)?
  var bestAttemptContent: UNMutableNotificationContent?

  // Matches AppConfig.apiBaseUrl's production default (apps/mobile/lib/api/app_config.dart)
  // — this extension has no build-time --dart-define plumbing to read that from, and
  // this app only ever ships one production backend, so a literal here doesn't drift
  // the way it would in a project with real per-environment extension builds.
  private static let apiBaseUrl = "https://apk4game.com"

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    self.contentHandler = contentHandler
    let content = (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    bestAttemptContent = content

    guard
      let messageId = request.content.userInfo["messageId"] as? String,
      let deliveryToken = request.content.userInfo["deliveryToken"] as? String,
      let url = URL(string: "\(Self.apiBaseUrl)/api/messages/\(messageId)/delivered-via-push")
    else {
      // No token in this payload (a call push, or an older server build) — nothing
      // for this extension to do; hand the content back exactly as received.
      contentHandler(request.content)
      return
    }

    var urlRequest = URLRequest(url: url)
    urlRequest.httpMethod = "POST"
    urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
    urlRequest.httpBody = try? JSONSerialization.data(withJSONObject: ["token": deliveryToken])
    // Comfortably under Apple's own ~30s extension budget, leaving room for
    // serviceExtensionTimeWillExpire's own fallback to still fire cleanly if this
    // somehow doesn't come back in time.
    urlRequest.timeoutInterval = 10

    let task = URLSession.shared.dataTask(with: urlRequest) { [weak self] _, _, _ in
      // Best-effort, same as every other delivered-ack in this app (see
      // push_notifications.dart's own `_ackDelivered` docstring) — a failure here
      // just means `delivered` stays unset until the recipient actually opens the
      // app, the same fallback this whole feature has without this extension at
      // all. Never worth failing the notification display over.
      guard let self = self, let bestAttemptContent = self.bestAttemptContent else { return }
      self.contentHandler?(bestAttemptContent)
    }
    task.resume()
  }

  override func serviceExtensionTimeWillExpire() {
    // Apple's budget ran out before the redemption POST completed — show the
    // notification regardless; the ack attempt just didn't make it in time, same
    // as any other dropped delivered-ack.
    if let contentHandler = contentHandler, let bestAttemptContent = bestAttemptContent {
      contentHandler(bestAttemptContent)
    }
  }
}
