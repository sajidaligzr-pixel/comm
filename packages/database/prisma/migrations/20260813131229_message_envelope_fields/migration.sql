-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "envelope_header" BYTEA,
ADD COLUMN     "x3dh_init" JSONB;
