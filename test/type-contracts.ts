import { operationResultSchema } from '../src/core/types.js';
import { z } from 'zod';
import { readCapability, writeCapability } from '../src/core/capability.js';

interface Session { profile: { id: string; name: string }; token: string }
const acceptance = { offline: true, liveRead: false, liveWrite: false };
export const read = readCapability<Session>()({
  id: 'example.read', description: 'Typed input and output', acceptance,
  input: z.object({ limit: z.number().default(20) }), output: z.object({ name: z.string() }),
  execute: async (context, input) => {
    const limit: number = input.limit;
    // @ts-expect-error The schema does not declare platform-specific or arbitrary fields.
    input.category;
    // @ts-expect-error Read handlers cannot request a durable write step.
    context.step;
    return { name: context.session.token + limit };
  },
});
export const write = writeCapability<Session>()({
  id: 'example.write', description: 'Typed prepared payload', acceptance,
  input: z.object({ value: z.string() }), prepared: z.object({ data: z.string() }), output: operationResultSchema, successStates: ['published'],
  prepare: async input => ({ data: input.value }), preflight: async () => undefined,
  execute: async (context, prepared) => {
    // @ts-expect-error Prepared payload follows its own schema rather than an untyped record.
    prepared.value;
    const token: string = context.session.token;
    return { status: 'published', remote: { kind: 'custom-resource', id: prepared.data + token } };
  },
});
