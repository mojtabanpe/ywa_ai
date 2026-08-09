import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DiscoveryModule } from './discovery/discovery.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({ connection: { host: config.get('REDIS_HOST', 'localhost'), port: Number(config.get('REDIS_PORT', 6379)) } }),
    }),
    PrismaModule,
    DiscoveryModule,
  ],
})
export class AppModule {}
