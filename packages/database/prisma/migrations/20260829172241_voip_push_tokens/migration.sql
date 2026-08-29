-- CreateTable
CREATE TABLE "voip_push_tokens" (
    "device_id" UUID NOT NULL,
    "token_ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "voip_push_tokens_pkey" PRIMARY KEY ("device_id")
);

-- AddForeignKey
ALTER TABLE "voip_push_tokens" ADD CONSTRAINT "voip_push_tokens_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
