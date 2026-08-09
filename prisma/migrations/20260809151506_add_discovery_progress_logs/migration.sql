-- AlterTable
ALTER TABLE "public"."DiscoveryRun" ADD COLUMN     "currentStep" TEXT,
ADD COLUMN     "progress" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "public"."DiscoveryRunLog" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "level" "public"."ScriptGenerationLogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DiscoveryRunLog_runId_createdAt_idx" ON "public"."DiscoveryRunLog"("runId", "createdAt");

-- AddForeignKey
ALTER TABLE "public"."DiscoveryRunLog" ADD CONSTRAINT "DiscoveryRunLog_runId_fkey" FOREIGN KEY ("runId") REFERENCES "public"."DiscoveryRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
