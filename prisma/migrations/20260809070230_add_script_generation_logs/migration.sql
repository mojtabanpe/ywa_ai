-- CreateEnum
CREATE TYPE "public"."ScriptGenerationLogLevel" AS ENUM ('INFO', 'ERROR');

-- AlterTable
ALTER TABLE "public"."Content" ADD COLUMN     "scriptProgress" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."ScriptGenerationLog" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "level" "public"."ScriptGenerationLogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScriptGenerationLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScriptGenerationLog_contentId_createdAt_idx" ON "public"."ScriptGenerationLog"("contentId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."ScriptGenerationLog" ADD CONSTRAINT "ScriptGenerationLog_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "public"."Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;
