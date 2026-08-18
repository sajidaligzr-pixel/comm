-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('answered', 'missed', 'declined');

-- CreateTable
CREATE TABLE "calls" (
    "id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "initiator_user_id" UUID NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'missed',
    "started_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calls_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calls_conversation_id_created_at_idx" ON "calls"("conversation_id", "created_at");

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calls" ADD CONSTRAINT "calls_initiator_user_id_fkey" FOREIGN KEY ("initiator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
