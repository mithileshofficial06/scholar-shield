/**
 * Rate limiters backed by Redis.
 *
 * express-rate-limit keeps its counters in process memory by default, which
 * means a restart resets every limit and two API replicas each allow the full
 * quota — so "10 sign-in attempts per 15 minutes" was really "10 per replica
 * per restart". Redis is already part of the stack for the pipeline queue, so
 * the counters live there instead, shared by every instance.
 *
 * Unit tests use the in-memory store: they must not need a Redis server, and a
 * limiter constructed at import time would otherwise open a socket on import.
 */

import rateLimit, { type Options } from 'express-rate-limit';
import { Redis } from 'ioredis';
import { RedisStore } from 'rate-limit-redis';

import { config } from './config.js';

let client: Redis | null = null;

function redis(): Redis {
  if (!client) {
    client = new Redis(config.REDIS_URL, {
      // Offline, a limiter should fail open with an error log rather than hang
      // every sign-in request waiting for Redis to come back.
      maxRetriesPerRequest: 1,
      enableOfflineQueue: true,
    });
    client.on('error', (err) => console.error('[rate-limit] redis error:', err.message));
  }
  return client;
}

export function limiter(
  name: string,
  options: Pick<Options, 'windowMs' | 'limit' | 'message'>,
) {
  const store =
    config.NODE_ENV === 'test'
      ? undefined
      : new RedisStore({
          prefix: `rl:${name}:`,
          sendCommand: (command: string, ...args: string[]) =>
            redis().call(command, ...args) as Promise<number>,
        });

  return rateLimit({
    ...options,
    standardHeaders: true,
    legacyHeaders: false,
    store,
    // A limiter whose store is down lets the request through and logs it. The
    // alternative is every sign-in failing because a counter is unreachable.
    passOnStoreError: true,
  });
}
