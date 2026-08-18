/// One row in a conversation list — pulled out of chats_list_screen.dart so
/// archived_chats_screen.dart (its own full page, not an inline dropdown — see that
/// file's docstring) renders chats identically instead of drifting out of sync with
/// a copy-pasted version.
library;

import 'package:flutter/material.dart';

import '../../api/dtos.dart';
import '../../app/app.dart' show WhatsAppColors;

Widget buildChatListTile(
  ConversationSummary c, {
  required VoidCallback onTap,
  required VoidCallback onLongPress,
}) {
  return ListTile(
    leading: CircleAvatar(
      child: Text(
        c.displayTitle().isNotEmpty ? c.displayTitle()[0].toUpperCase() : '?',
      ),
    ),
    title: Text(c.displayTitle()),
    subtitle: c.type == 'group'
        ? Text('${c.groupMemberCount ?? 0} members')
        : null,
    trailing: c.unreadCount > 0
        ? CircleAvatar(
            radius: 11,
            backgroundColor: WhatsAppColors.green,
            child: Text(
              '${c.unreadCount}',
              style: const TextStyle(fontSize: 11, color: Colors.white),
            ),
          )
        : null,
    onTap: onTap,
    onLongPress: onLongPress,
  );
}
