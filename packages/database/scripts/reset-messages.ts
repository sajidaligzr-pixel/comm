import { config } from 'dotenv';
config();

import { prisma } from '../src/index.js';

/**
 * Wipes ALL messaging data (conversations, messages, groups, and everything that
 * hangs off them) while leaving every account (User/Admin/Device/Session/Invite/
 * keys) completely untouched — asked for directly ("delete all the old chats
 * between users... keep the users... we need a fresh start"), to clear
 * accumulated test-account chat history without anyone having to re-register a
 * device or lose their login.
 *
 * Deliberately only touches Group/Conversation — every other messaging-related
 * table (Message, ConversationMember, MessageRecipient, MessageReaction,
 * MessageAttachment, GroupMember, GroupSession, GroupKeyShare) already has
 * `onDelete: Cascade` back to one of these two in schema.prisma, so deleting just
 * these two is sufficient — everything downstream goes with them, nothing needs
 * deleting by hand in the right order.
 *
 * Does NOT delete the underlying object-storage files for any attachments that
 * were sent (local-fs or S3 ciphertext blobs) — apps/worker's existing cleanup job
 * (jobs/cleanup.ts) already sweeps storage objects with no matching
 * `message_attachments` row, which is exactly what every one of them becomes the
 * instant this runs, so they're reclaimed on its normal schedule rather than here.
 *
 * Irreversible — there is no soft-delete or undo for any of this. Requires an
 * explicit --yes flag on top of already being something only someone with direct
 * server access can even run (never exposed as an HTTP route, same reasoning as
 * bootstrap-admin.ts).
 *
 * Usage (from packages/database, on the actual server — this reads that
 * directory's own DATABASE_URL, same as every other script here):
 *   npm run reset-messages -- --yes
 */
async function main() {
  const confirmed = process.argv.includes('--yes');

  // groupConversationCount is deliberately a Conversation query (type: 'group'),
  // not prisma.group.count() — found live while dry-running this locally: a Group
  // row isn't guaranteed to have a matching Conversation (the back-relation is
  // nullable), so counting Group rows directly overstated/understated the "of them
  // group chats" breakdown below versus what conversation.deleteMany's own count
  // actually reports afterward. Doesn't affect the deletion itself either way —
  // both deleteMany calls below are unconditional (`{}`) regardless of this number.
  const [groupConversationCount, conversationCount, messageCount] = await Promise.all([
    prisma.conversation.count({ where: { type: 'group' } }),
    prisma.conversation.count(),
    prisma.message.count(),
  ]);

  console.log('');
  console.log('This will permanently delete:');
  console.log(`  ${conversationCount} conversation(s) (${groupConversationCount} of them group chats)`);
  console.log(`  ${messageCount} message(s) — and everything attached to them: attachments, reactions,`);
  console.log('  delivery/read receipts, group membership, and group key material.');
  console.log('');
  console.log('User accounts, devices, and login sessions are NOT touched — everyone keeps their');
  console.log('login exactly as it is now, just with an empty chat list afterward.');
  console.log('');

  if (!confirmed) {
    console.log('Nothing deleted (dry run). Re-run with --yes to actually do this:');
    console.log('  npm run reset-messages -- --yes');
    process.exit(0);
  }

  // Groups first — deleting a Group cascades to its own Conversation row too (the
  // FK is Conversation.groupId -> Group.id, onDelete: Cascade), which in turn
  // cascades to that conversation's messages/members — so this alone clears every
  // group conversation completely.
  const { count: groupsDeleted } = await prisma.group.deleteMany({});
  // Whatever conversations remain are the direct (1:1) ones — cascades to their
  // own messages/members the same way.
  const { count: conversationsDeleted } = await prisma.conversation.deleteMany({});

  console.log(`✅ Deleted ${groupsDeleted} group(s) and ${conversationsDeleted} direct conversation(s), and everything attached to them.`);
  console.log('   Accounts are untouched — sign in exactly as before, with a clean slate.');
  console.log('');

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error('Reset failed:', err);
  process.exit(1);
});
