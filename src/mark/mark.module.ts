import { Module } from '@nestjs/common';

// The Mark agent (orchestrator, websocket gateway, provider abstraction and
// token calculator) was removed. What remains is a dormant toolkit: the
// html/pdf/validation utils and the searchWeb helper, pending the full
// src/mark dissolution (#128).
@Module({})
export class MarkModule {}
