-- AlterTable
ALTER TABLE "message_recipients" ADD COLUMN     "ciphertext" BYTEA,
ADD COLUMN     "envelope_header" BYTEA,
ADD COLUMN     "x3dh_init" JSONB;
