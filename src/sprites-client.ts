import { SpritesClient } from '@fly/sprites';
import type { VM } from './types.js';

export function createSpritesClient(): SpritesClient {
  const token = process.env.SPRITES_TOKEN;
  if (!token) {
    throw new Error('SPRITES_TOKEN environment variable is required');
  }
  return new SpritesClient(token);
}

export async function listVMs(client: SpritesClient): Promise<VM[]> {
  const sprites = await client.listAllSprites('pigs-');
  return sprites.map((s: any) => ({
    name: s.name,
    id: s.id ?? s.name,
    status: s.status ?? 'running',
    createdAt: s.created_at ?? s.updated_at ?? new Date().toISOString(),
    needsAttention: false,
  }));
}

export async function createVM(client: SpritesClient, name: string): Promise<VM> {
  const sprite = await client.createSprite(name);
  return {
    name: (sprite as any).name ?? name,
    id: (sprite as any).id ?? name,
    status: 'cold',
    createdAt: new Date().toISOString(),
    needsAttention: false,
  };
}

export async function deleteVM(client: SpritesClient, name: string): Promise<void> {
  await client.deleteSprite(name);
}
