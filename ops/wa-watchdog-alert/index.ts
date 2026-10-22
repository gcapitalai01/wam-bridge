import { createAlertHandler } from './handler.js';
Deno.serve(createAlertHandler(name => Deno.env.get(name)));
