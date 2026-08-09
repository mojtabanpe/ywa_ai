import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { DiscoveryService } from './discovery.service';
@Processor('discovery')
export class DiscoveryProcessor extends WorkerHost { constructor(private readonly discovery: DiscoveryService) { super(); } async process(job: Job<{ runId: string }>) { return this.discovery.process(job.data.runId); } }
