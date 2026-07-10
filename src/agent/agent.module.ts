import { Global, Module } from '@nestjs/common';
import { AgentService } from './agent.service';
import { AgentRunnerService } from './agent-runner.service';
import { AgentController } from './agent.controller';

@Global()
@Module({
  providers: [AgentService, AgentRunnerService],
  controllers: [AgentController],
  exports: [AgentService, AgentRunnerService],
})
export class AgentModule {}
