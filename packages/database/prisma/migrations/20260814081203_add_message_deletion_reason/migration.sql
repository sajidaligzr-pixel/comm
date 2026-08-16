-- CreateEnum
CREATE TYPE "MessageDeletionReason" AS ENUM ('manual', 'disappearing_timer', 'media_retention');

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "deletion_reason" "MessageDeletionReason";

