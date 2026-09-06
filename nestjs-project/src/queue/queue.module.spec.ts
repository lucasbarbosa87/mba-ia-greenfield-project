import { getQueueToken } from '@nestjs/bullmq';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import type { Queue } from 'bullmq';
import queueConfig from '../config/queue.config';
import { QUEUE_NAMES } from './queue.constants';
import { QueueModule } from './queue.module';

describe('QueueModule', () => {
  beforeAll(() => {
    process.env.REDIS_HOST = 'redis';
    process.env.REDIS_PORT = '6379';
  });

  it('should compile without DI errors', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    expect(moduleRef).toBeDefined();
  });

  it('should inject a valid Queue instance for video-processing', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, load: [queueConfig] }),
        QueueModule,
      ],
    }).compile();

    const queue = moduleRef.get<Queue>(
      getQueueToken(QUEUE_NAMES.VIDEO_PROCESSING),
    );

    expect(queue).toBeDefined();
    expect(queue.name).toBe(QUEUE_NAMES.VIDEO_PROCESSING);

    await queue.close();
  });
});
