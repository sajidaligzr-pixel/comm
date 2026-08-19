/// Tiny cross-controller coordination so `CallController` (1:1) and
/// `GroupCallController` — two independent Riverpod controllers, deliberately
/// never merged (see group_call_controller.dart's own docstring for why 1:1
/// calling stays completely untouched by the group-call feature) — can't both go
/// active at once. Mobile counterpart to `apps/web/lib/call-coordination.ts`; see
/// that file's own docstring for the full reasoning, identical here.
library;

enum ActiveCallKind { oneToOne, group }

ActiveCallKind? _active;

ActiveCallKind? getActiveCallKind() => _active;

void setActiveCallKind(ActiveCallKind? kind) => _active = kind;
