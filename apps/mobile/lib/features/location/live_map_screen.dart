/// Live location map (docs/09-trust-boundaries.md's "Live location sharing"
/// exception) — the mobile counterpart to apps/web's
/// components/location/live-map-view.tsx. Reachable only for an Admin or granted
/// `LocationViewer` account (see chats_list_screen.dart's nav-gating check,
/// mirroring how it already gates the Admin screen); `listLive()` doubling as
/// this client's own "am I allowed here?" check is a UI convenience only, not the
/// real authorization boundary (server/common/auth.ts's `requireLocationAccess`
/// re-derives it from the database on every request regardless).
///
/// OpenStreetMap raster tiles (open-source, no API key/billing) via flutter_map —
/// matches what was asked for over a proprietary provider like Google Maps.
library;

import 'package:flutter/material.dart';
import 'package:flutter_map/flutter_map.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:latlong2/latlong.dart' show LatLng;

import '../../api/api_client.dart';
import '../../api/dtos.dart';
import '../../app/providers.dart';
import '../../shared/widgets/error_state.dart';

// Same fixed palette as apps/web/components/chat/avatar.tsx's `PALETTE` — kept in
// sync by eye (small, stable list) so the same person reads as the same color on
// both platforms, not because either imports the other (they can't).
const _palette = [
  Color(0xFF7C6EF2),
  Color(0xFF2FA8A0),
  Color(0xFFE0724A),
  Color(0xFF3E8ED0),
  Color(0xFFC24E7F),
  Color(0xFF5AA454),
  Color(0xFFB08B2B),
  Color(0xFF8B5CF6),
];

Color _pinColor(String seed) {
  var hash = 0;
  for (final unit in seed.codeUnits) {
    hash = (hash * 31 + unit) & 0x7fffffff;
  }
  return _palette[hash % _palette.length];
}

String _initials(String name) {
  final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty).toList();
  if (parts.isEmpty) return '?';
  if (parts.length == 1) return parts.first.substring(0, parts.first.length.clamp(0, 2)).toUpperCase();
  return (parts.first[0] + parts.last[0]).toUpperCase();
}

class LiveMapScreen extends ConsumerStatefulWidget {
  const LiveMapScreen({super.key});
  @override
  ConsumerState<LiveMapScreen> createState() => _LiveMapScreenState();
}

class _LiveMapScreenState extends ConsumerState<LiveMapScreen> {
  final Map<String, LiveLocationDto> _locations = {};
  bool _loading = true;
  bool _forbidden = false;
  String? _error;
  bool _fitted = false;
  final _mapController = MapController();

  @override
  void initState() {
    super.initState();
    _load();
    ref.read(realtimeClientProvider).on('location.updated', _onLocationUpdated);
  }

  @override
  void dispose() {
    ref.read(realtimeClientProvider).off('location.updated', _onLocationUpdated);
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final locations = await ref.read(locationsApiProvider).listLive();
      if (!mounted) return;
      setState(() {
        _locations
          ..clear()
          ..addEntries(locations.map((l) => MapEntry(l.userId, l)));
        _loading = false;
        _forbidden = false;
        _error = null;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _forbidden = e.code == 'FORBIDDEN';
        _error = _forbidden ? null : e.message;
      });
    }
  }

  void _onLocationUpdated(Map<String, dynamic> payload) {
    final raw = payload['location'] as Map<String, dynamic>?;
    if (raw == null) return;
    final location = LiveLocationDto.fromJson(raw);
    if (!mounted) return;
    setState(() => _locations[location.userId] = location);
  }

  void _fitToMarkers(List<LiveLocationDto> locations) {
    if (_fitted || locations.isEmpty) return;
    _fitted = true;
    if (locations.length == 1) {
      _mapController.move(LatLng(locations.first.latitude, locations.first.longitude), 14);
      return;
    }
    final bounds = LatLngBounds.fromPoints(
      locations.map((l) => LatLng(l.latitude, l.longitude)).toList(),
    );
    _mapController.fitCamera(CameraFit.bounds(bounds: bounds, padding: const EdgeInsets.all(48)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Live location')),
      body: _buildBody(),
    );
  }

  Widget _buildBody() {
    if (_forbidden) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text('You do not have permission to view this.', textAlign: TextAlign.center),
        ),
      );
    }
    if (_error != null) return ErrorState(message: _error!, onRetry: _load);
    if (_loading) return const Center(child: CircularProgressIndicator());

    final locations = _locations.values.toList();
    if (locations.isEmpty) {
      return const Center(child: Text('No one has shared their location yet.'));
    }
    WidgetsBinding.instance.addPostFrameCallback((_) => _fitToMarkers(locations));

    return FlutterMap(
      mapController: _mapController,
      options: MapOptions(
        initialCenter: LatLng(locations.first.latitude, locations.first.longitude),
        initialZoom: 12,
      ),
      children: [
        TileLayer(
          urlTemplate: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
          userAgentPackageName: 'com.comm.comm_mobile',
        ),
        MarkerLayer(
          markers: locations
              .map(
                (location) => Marker(
                  point: LatLng(location.latitude, location.longitude),
                  width: 40,
                  height: 40,
                  child: GestureDetector(
                    onTap: () => _showInfo(location),
                    child: _Pin(displayName: location.displayName),
                  ),
                ),
              )
              .toList(),
        ),
      ],
    );
  }

  void _showInfo(LiveLocationDto location) {
    showModalBottomSheet(
      context: context,
      builder: (context) => Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(location.displayName, style: Theme.of(context).textTheme.titleMedium),
            Text('@${location.username}', style: Theme.of(context).textTheme.bodySmall),
            const SizedBox(height: 8),
            Text(
              'Updated ${_formatRelative(location.updatedAt)}',
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }
}

String _formatRelative(String iso) {
  final parsed = DateTime.tryParse(iso);
  if (parsed == null) return iso;
  final diff = DateTime.now().difference(parsed);
  if (diff.inMinutes < 1) return 'just now';
  if (diff.inMinutes < 60) return '${diff.inMinutes} minute${diff.inMinutes == 1 ? '' : 's'} ago';
  if (diff.inHours < 24) return '${diff.inHours} hour${diff.inHours == 1 ? '' : 's'} ago';
  return '${diff.inDays} day${diff.inDays == 1 ? '' : 's'} ago';
}

class _Pin extends StatelessWidget {
  const _Pin({required this.displayName});
  final String displayName;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 34,
      height: 34,
      decoration: BoxDecoration(
        color: _pinColor(displayName.isEmpty ? '?' : displayName),
        shape: BoxShape.circle,
        border: Border.all(color: Colors.white, width: 2),
        boxShadow: const [BoxShadow(color: Colors.black38, blurRadius: 4, offset: Offset(0, 1))],
      ),
      alignment: Alignment.center,
      child: Text(
        _initials(displayName.isEmpty ? '?' : displayName),
        style: const TextStyle(color: Colors.white, fontWeight: FontWeight.w600, fontSize: 12),
      ),
    );
  }
}
