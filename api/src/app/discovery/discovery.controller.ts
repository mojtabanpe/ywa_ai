import { Controller, Get, Param, Post } from '@nestjs/common';
import { DiscoveryService } from './discovery.service';
import { ScriptService } from './script.service';
@Controller('discovery')
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService, private readonly scripts: ScriptService) {}
  @Post('runs') start() { return this.discovery.enqueue(); }
  @Get('runs') runs() { return this.discovery.runs(); }
  @Get('runs/:id') run(@Param('id') id: string) { return this.discovery.run(id); }
  @Get('topics') topics() { return this.discovery.topTopics(); }
  @Post('topics/:id/approve') approve(@Param('id') id: string) { return this.scripts.approve(id); }
  @Post('topics/:id/script') script(@Param('id') id: string) { return this.scripts.generate(id); }
  @Get('topics/:id/script') getScript(@Param('id') id: string) { return this.scripts.get(id); }
}
