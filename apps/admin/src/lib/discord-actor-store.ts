import { AsyncLocalStorage } from 'node:async_hooks';

// The linked exec a Discord console command runs as. A leaf module that
// imports nothing else, so audit.ts and supabase-server.ts can read it without
// pulling the rest of discord-actor.ts (and its Supabase reads) into every
// test that touches them. discord-actor.ts re-exports it.
//
// Set ONLY by the /api/discord/* routes, after the service secret has been
// checked. Node runtime only: the middleware must never import this.
export interface DiscordActor {
  playerId: string;
  discordUserId: string;
}

export const discordActorStore = new AsyncLocalStorage<DiscordActor>();
