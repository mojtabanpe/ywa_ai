-- CreateEnum
CREATE TYPE "public"."SourceType" AS ENUM ('RSS', 'REDDIT', 'YOUTUBE', 'INSTAGRAM');

-- CreateEnum
CREATE TYPE "public"."DiscoveryRunStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateTable
CREATE TABLE "public"."Source" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "public"."SourceType" NOT NULL,
    "url" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Source_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."Content" (
    "id" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "author" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "publishedAt" TIMESTAMP(3),
    "rawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Content_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."ContentScore" (
    "id" TEXT NOT NULL,
    "contentId" TEXT NOT NULL,
    "viralScore" INTEGER NOT NULL,
    "noveltyScore" INTEGER NOT NULL,
    "usefulnessScore" INTEGER NOT NULL,
    "persianAudienceScore" INTEGER NOT NULL,
    "visualScore" INTEGER NOT NULL,
    "totalScore" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentScore_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "public"."DiscoveryRun" (
    "id" TEXT NOT NULL,
    "status" "public"."DiscoveryRunStatus" NOT NULL DEFAULT 'QUEUED',
    "sourceCount" INTEGER NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DiscoveryRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Source_type_url_key" ON "public"."Source"("type", "url");

-- CreateIndex
CREATE INDEX "Content_publishedAt_idx" ON "public"."Content"("publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Content_sourceId_externalId_key" ON "public"."Content"("sourceId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentScore_contentId_key" ON "public"."ContentScore"("contentId");

-- CreateIndex
CREATE INDEX "ContentScore_totalScore_idx" ON "public"."ContentScore"("totalScore");

-- AddForeignKey
ALTER TABLE "public"."Content" ADD CONSTRAINT "Content_sourceId_fkey" FOREIGN KEY ("sourceId") REFERENCES "public"."Source"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "public"."ContentScore" ADD CONSTRAINT "ContentScore_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "public"."Content"("id") ON DELETE CASCADE ON UPDATE CASCADE;
