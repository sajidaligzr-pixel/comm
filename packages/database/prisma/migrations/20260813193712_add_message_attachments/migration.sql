-- AlterEnum
ALTER TYPE "MessageEnvelopeType" ADD VALUE 'megolm_group';

-- CreateTable
CREATE TABLE "message_attachments" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "object_key" TEXT NOT NULL,
    "encrypted_size_bytes" BIGINT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_message_id_key" ON "message_attachments"("message_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_attachments_object_key_key" ON "message_attachments"("object_key");

-- AddForeignKey
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
