import { Body, Controller, Get, Post } from '@nestjs/common';
import { GeminiRequest, GeminiService } from './gemini.service';

@Controller('gemini')
export class GeminiController {
  constructor(private readonly gemini: GeminiService) {}

  @Get('status')
  status() {
    return this.gemini.status();
  }

  @Post('image')
  image(@Body() body: { prompt?: string }) {
    return this.gemini.generateImage(body.prompt || '');
  }

  @Post('omni')
  omni(@Body() body: GeminiRequest) {
    return this.gemini.generateOmni(body);
  }
}
