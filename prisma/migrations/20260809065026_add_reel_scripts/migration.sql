-- CreateEnum
CREATE TYPE "public"."ContentWorkflowStatus" AS ENUM ('DISCOVERED', 'APPROVED', 'SCRIPT_READY');

-- AlterTable
ALTER TABLE "public"."Content" ADD COLUMN     "workflowStatus" "public"."ContentWorkflowStatus" NOT NULL DEFAULT 'DISCOVERED';

-- CreateTable
CREATE TABLE "public"."ReelScript" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "hook" TEXT NOT NULL,
    "narration" TEXT NOT NULL,
    "visualPlan" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "cta" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReelScript_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReelScript_contentId_key" ON "public"."ReelScript"("contentId");

-- AddForeignKey
ALTER TABLE "public"."ReelScript" ADD CONSTRAINT "ReelScript_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "public"."Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;
