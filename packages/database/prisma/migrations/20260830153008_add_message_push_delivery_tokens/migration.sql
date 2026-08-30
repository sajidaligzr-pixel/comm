-- CreateTable
CREATE TABLE "message_push_delivery_tokens" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "token_hash" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_push_delivery_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "message_push_delivery_tokens_token_hash_key" ON "message_push_delivery_tokens"("token_hash");

-- AddForeignKey
ALTER TABLE "message_push_delivery_tokens" ADD CONSTRAINT "message_push_delivery_tokens_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_push_delivery_tokens" ADD CONSTRAINT "message_push_delivery_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
