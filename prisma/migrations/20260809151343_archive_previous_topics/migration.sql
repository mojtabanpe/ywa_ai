-- AlterTable
ALTER TABLE "public"."Content" ADD COLUMN     "archivedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Content_archivedAt_idx" ON "public"."Content"("archivedAt");
