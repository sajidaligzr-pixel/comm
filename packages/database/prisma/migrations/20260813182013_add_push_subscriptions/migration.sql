-- CreateEnum
CREATE TYPE "PushProvider" AS ENUM ('web_push', 'fcm');

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "device_id" UUID NOT NULL,
    "provider" "PushProvider" NOT NULL DEFAULT 'web_push',
    "subscription_ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("device_id")
);

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
