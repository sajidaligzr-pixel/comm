/*
  Warnings:

  - You are about to drop the column `nonce` on the `message_history_entries` table. All the data in the column will be lost.
  - You are about to drop the column `nonce` on the `user_history_keys` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "message_history_entries" DROP COLUMN "nonce";

-- AlterTable
ALTER TABLE "user_history_keys" DROP COLUMN "nonce";
