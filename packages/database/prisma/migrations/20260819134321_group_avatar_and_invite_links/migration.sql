-- AlterTable
ALTER TABLE "groups" ADD COLUMN     "avatar_object_key" TEXT;

-- CreateTable
CREATE TABLE "group_invite_links" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "token" TEXT NOT NULL,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "group_invite_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "group_invite_links_token_key" ON "group_invite_links"("token");

-- AddForeignKey
ALTER TABLE "group_invite_links" ADD CONSTRAINT "group_invite_links_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "group_invite_links" ADD CONSTRAINT "group_invite_links_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
