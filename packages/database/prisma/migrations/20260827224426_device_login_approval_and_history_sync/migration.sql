-- CreateEnum
CREATE TYPE "PendingDeviceLoginStatus" AS ENUM ('pending', 'approved', 'denied', 'completed');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "SecurityEventType" ADD VALUE 'new_device_login_requested';
ALTER TYPE "SecurityEventType" ADD VALUE 'new_device_login_approved';
ALTER TYPE "SecurityEventType" ADD VALUE 'new_device_login_denied';

-- CreateTable
CREATE TABLE "pending_device_logins" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "device_type" "DeviceType" NOT NULL,
    "key_bundle_payload" JSONB NOT NULL,
    "status" "PendingDeviceLoginStatus" NOT NULL DEFAULT 'pending',
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pending_device_logins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_history_keys" (
    "user_id" UUID NOT NULL,
    "wrapped_key" BYTEA NOT NULL,
    "salt" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_history_keys_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "message_history_entries" (
    "message_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "nonce" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_history_entries_pkey" PRIMARY KEY ("message_id","user_id")
);

-- CreateIndex
CREATE INDEX "pending_device_logins_user_id_status_idx" ON "pending_device_logins"("user_id", "status");

-- CreateIndex
CREATE INDEX "message_history_entries_user_id_created_at_idx" ON "message_history_entries"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "pending_device_logins" ADD CONSTRAINT "pending_device_logins_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_history_keys" ADD CONSTRAINT "user_history_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_history_entries" ADD CONSTRAINT "message_history_entries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_history_entries" ADD CONSTRAINT "message_history_entries_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
