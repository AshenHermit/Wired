import { Module } from '@nestjs/common';
import { ProxyController } from './proxy.controller';

@Module({
  providers: [],
  controllers: [ProxyController],
})
export class ProxyModule {}
