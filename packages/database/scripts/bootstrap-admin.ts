import { config } from 'dotenv';
config();

import { prisma } from '../src/index.js';
import { hashPassword, generateSecureToken } from '@comm/security';

/**
 * The one-time bootstrap for a closed system (docs/07-auth-architecture.md): every
 * other account is provisioned by an admin through the app, but the *first* admin
 * has no admin to provision them. This script is that exception — run once, by
 * someone with direct database access, never exposed as an HTTP route (there is no
 * such route, by design; this is the only way to create an admin without already
 * being one).
 *
 * Usage:
 *   npm run db:bootstrap-admin -- --username=talal --name="Talal"
 *
 * Password: set ADMIN_PASSWORD in the environment to choose one (never pass it as a
 * CLI flag — that lands in shell history). If omitted, a random 24-character
 * password is generated and printed ONCE below; nothing after this run can recover
 * it, since only its Argon2id hash is ever stored (the same rule that applies to
 * every other password in this system, docs/38-logging's "never log the password").
 */
async function main() {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const [key, ...rest] = arg.replace(/^--/, '').split('=');
      return [key, rest.join('=')];
    }),
  );

  const username = (args.username ?? '').trim().toLowerCase();
  const displayName = (args.name ?? args.username ?? '').trim();

  if (!username || !/^[a-z0-9_]{3,32}$/.test(username)) {
    console.error('Usage: npm run db:bootstrap-admin -- --username=<3-32 lowercase letters/numbers/underscores> --name="Display Name"');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    console.error(`User @${username} already exists (status: ${existing.status}). Refusing to overwrite — use the app's own account-recovery invite flow instead if this account needs a new password.`);
    process.exit(1);
  }

  const password = process.env.ADMIN_PASSWORD ?? generateSecureToken(18);
  const passwordGenerated = !process.env.ADMIN_PASSWORD;
  const passwordHash = await hashPassword(password);

  const user = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      // mustChangePassword: true — this password was set by whoever ran this script,
      // not chosen by the account's actual owner, so the app forces a change on
      // first real login rather than leaving a script-known credential live
      // indefinitely (docs/07-auth-architecture.md).
      data: { username, displayName: displayName || username, status: 'active', passwordHash, mustChangePassword: true },
    });
    await tx.admin.create({ data: { userId: user.id, role: 'superadmin' } });
    await tx.userPrivacySetting.create({ data: { userId: user.id } });
    await tx.notificationPreference.create({ data: { userId: user.id } });
    await tx.securityEvent.create({
      data: { userId: user.id, eventType: 'account_provisioned', metadata: { via: 'bootstrap_script' } },
    });
    return user;
  });

  console.log('');
  console.log(`✅ Admin account created: @${user.username}`);
  if (passwordGenerated) {
    console.log('');
    console.log(`   Password (shown once — copy it now): ${password}`);
  } else {
    console.log('   Password: set via ADMIN_PASSWORD (not shown/logged).');
  }
  console.log('');
  console.log(`   Sign in at /login. This account can then provision every other`);
  console.log(`   account through Settings → Admin — see docs/07-auth-architecture.md.`);
  console.log('');

  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error('Bootstrap failed:', err);
  process.exit(1);
});
