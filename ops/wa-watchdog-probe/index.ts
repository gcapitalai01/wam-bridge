import { createProbe } from './probe.js';
import { createAlertHandler } from './handler.js';
const env = (name: string) => Deno.env.get(name);
Deno.serve(createProbe(env, createAlertHandler(env)));
