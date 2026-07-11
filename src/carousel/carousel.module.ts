import { Module } from '@nestjs/common';
import { CarouselTemplatesService } from './carousel-templates.service';

@Module({
  providers: [CarouselTemplatesService],
  exports: [CarouselTemplatesService],
})
export class CarouselModule {}
