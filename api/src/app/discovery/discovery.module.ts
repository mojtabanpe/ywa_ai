import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { DiscoveryController } from './discovery.controller';
import { DiscoveryProcessor } from './discovery.processor';
import { DiscoveryService } from './discovery.service';
import { AiNewsRssProvider } from './rss.provider';
import { ArticleMetadataService } from './article-metadata.service';
import { TopicScoringService } from './scoring.service';
import { ScriptService } from './script.service';
import { PrismaModule } from '../prisma/prisma.module';
@Module({ imports: [BullModule.registerQueue({ name: 'discovery' }), PrismaModule], controllers: [DiscoveryController], providers: [DiscoveryService, DiscoveryProcessor, AiNewsRssProvider, ArticleMetadataService, TopicScoringService, ScriptService] })
export class DiscoveryModule {}
