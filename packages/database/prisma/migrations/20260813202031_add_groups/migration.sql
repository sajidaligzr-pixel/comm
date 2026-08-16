-- CreateEnum
CREATE TYPE "GroupRole" AS ENUM ('member', 'admin');

-- AlterEnum
ALTER TYPE "ConversationType" ADD VALUE 'group';

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "group_id" UUID;

-- CreateTable
CREATE TABLE "groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "only_admins_can_message" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_members" (
    "group_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "GroupRole" NOT NULL DEFAULT 'member',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removed_at" TIMESTAMP(3),

    CONSTRAINT "group_members_pkey" PRIMARY KEY ("group_id","user_id")
);

-- CreateTable
CREATE TABLE "group_sessions" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "superseded_at" TIMESTAMP(3),

    CONSTRAINT "group_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "group_key_shares" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "epoch" INTEGER NOT NULL,
    "from_device_id" UUID NOT NULL,
    "to_device_id" UUID NOT NULL,
    "envelope_header" BYTEA NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "x3dh_init" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumed_at" TIMESTAMP(3),

    CONSTRAINT "group_key_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_sessions_group_id_epoch_key" ON "group_sessions"("group_id", "epoch");

-- CreateIndex
CREATE INDEX "group_key_shares_to_device_id_consumed_at_idx" ON "group_key_shares"("to_device_id", "consumed_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversations_group_id_key" ON "conversations"("group_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_sessions" ADD CONSTRAINT "group_sessions_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_key_shares" ADD CONSTRAINT "group_key_shares_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_key_shares" ADD CONSTRAINT "group_key_shares_from_device_id_fkey" FOREIGN KEY ("from_device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_key_shares" ADD CONSTRAINT "group_key_shares_to_device_id_fkey" FOREIGN KEY ("to_device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

