-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('pending_invite', 'active', 'suspended', 'deleted');

-- CreateEnum
CREATE TYPE "AdminRole" AS ENUM ('superadmin', 'support');

-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('web', 'android', 'desktop');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('active', 'revoked');

-- CreateEnum
CREATE TYPE "RevokedReason" AS ENUM ('user', 'admin', 'security_event');

-- CreateEnum
CREATE TYPE "SecurityEventType" AS ENUM ('login_success', 'login_failed', 'new_device_linked', 'device_revoked', 'password_changed', 'identity_key_changed', 'session_revoked', 'suspicious_login', 'account_provisioned', 'account_suspended');

-- CreateEnum
CREATE TYPE "VisibilityLevel" AS ENUM ('everyone', 'contacts', 'nobody');

-- CreateEnum
CREATE TYPE "OnlineStatusMode" AS ENUM ('everyone', 'same_as_last_seen');

-- CreateEnum
CREATE TYPE "GroupsAddMeMode" AS ENUM ('everyone', 'contacts');

-- CreateEnum
CREATE TYPE "NotificationDefaultMode" AS ENUM ('all', 'mentions_only', 'none');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" CITEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "about" TEXT,
    "avatar_object_key" TEXT,
    "password_hash" TEXT,
    "status" "UserStatus" NOT NULL DEFAULT 'pending_invite',
    "created_by_admin_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "AdminRole" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invites" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "issued_by_admin_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "redeemed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invites_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "device_type" "DeviceType" NOT NULL,
    "status" "DeviceStatus" NOT NULL DEFAULT 'active',
    "linked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "revoked_reason" "RevokedReason",

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "identity_keys" (
    "device_id" UUID NOT NULL,
    "public_key" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "identity_keys_pkey" PRIMARY KEY ("device_id")
);

-- CreateTable
CREATE TABLE "signed_pre_keys" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "key_id" INTEGER NOT NULL,
    "public_key" BYTEA NOT NULL,
    "signature" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "rotated_at" TIMESTAMP(3),

    CONSTRAINT "signed_pre_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "one_time_pre_keys" (
    "id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "key_id" INTEGER NOT NULL,
    "public_key" BYTEA NOT NULL,
    "claimed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "one_time_pre_keys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "access_token_family" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),
    "ip_hash" TEXT,
    "user_agent" TEXT,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_events" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "event_type" "SecurityEventType" NOT NULL,
    "device_id" UUID,
    "ip_hash" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_privacy_settings" (
    "user_id" UUID NOT NULL,
    "last_seen" "VisibilityLevel" NOT NULL DEFAULT 'contacts',
    "online_status" "OnlineStatusMode" NOT NULL DEFAULT 'same_as_last_seen',
    "profile_photo" "VisibilityLevel" NOT NULL DEFAULT 'contacts',
    "about" "VisibilityLevel" NOT NULL DEFAULT 'contacts',
    "read_receipts" BOOLEAN NOT NULL DEFAULT true,
    "typing_indicators" BOOLEAN NOT NULL DEFAULT true,
    "calls" "VisibilityLevel" NOT NULL DEFAULT 'contacts',
    "groups_add_me" "GroupsAddMeMode" NOT NULL DEFAULT 'contacts',

    CONSTRAINT "user_privacy_settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "user_id" UUID NOT NULL,
    "conversations_default" "NotificationDefaultMode" NOT NULL DEFAULT 'all',
    "show_preview" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("user_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE UNIQUE INDEX "admins_user_id_key" ON "admins"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "invites_token_hash_key" ON "invites"("token_hash");

-- CreateIndex
CREATE INDEX "devices_user_id_idx" ON "devices"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "signed_pre_keys_device_id_key_id_key" ON "signed_pre_keys"("device_id", "key_id");

-- CreateIndex
CREATE INDEX "one_time_pre_keys_device_id_claimed_at_idx" ON "one_time_pre_keys"("device_id", "claimed_at");

-- CreateIndex
CREATE UNIQUE INDEX "one_time_pre_keys_device_id_key_id_key" ON "one_time_pre_keys"("device_id", "key_id");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_refresh_token_hash_key" ON "sessions"("refresh_token_hash");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_access_token_family_idx" ON "sessions"("access_token_family");

-- CreateIndex
CREATE INDEX "security_events_user_id_created_at_idx" ON "security_events"("user_id", "created_at" DESC);

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_created_by_admin_id_fkey" FOREIGN KEY ("created_by_admin_id") REFERENCES "admins"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admins" ADD CONSTRAINT "admins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invites" ADD CONSTRAINT "invites_issued_by_admin_id_fkey" FOREIGN KEY ("issued_by_admin_id") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "identity_keys" ADD CONSTRAINT "identity_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signed_pre_keys" ADD CONSTRAINT "signed_pre_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "one_time_pre_keys" ADD CONSTRAINT "one_time_pre_keys_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_privacy_settings" ADD CONSTRAINT "user_privacy_settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
