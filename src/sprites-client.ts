import { SpritesClient } from '@fly/sprites';
import type { Sprite } from '@fly/sprites';
import type { VM } from './types.js';

const VM_PREFIX = 'pigs-';

export function createSpritesClient(): SpritesClient {
  const token = process.env.SPRITES_TOKEN;
  if (!token) {
    throw new Error('SPRITES_TOKEN environment variable is required');
  }
  return new SpritesClient(token);
}

export function spriteToVM(sprite: Sprite): VM {
  return {
    name: sprite.name,
    id: sprite.id ?? sprite.name,
    status: (sprite.status as VM['status']) ?? 'cold',
    createdAt: sprite.createdAt?.toISOString() ?? new Date().toISOString(),
    needsAttention: false,
  };
}

export function generateVMName(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let suffix = '';
  for (let i = 0; i < 6; i++) {
    suffix += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${VM_PREFIX}${suffix}`;
}

export async function listVMs(client: SpritesClient): Promise<VM[]> {
  const sprites = await client.listAllSprites(VM_PREFIX);
  return sprites.map(spriteToVM);
}

export async function createVM(client: SpritesClient, name?: string): Promise<VM> {
  const vmName = name ?? generateVMName();
  const sprite = await client.createSprite(vmName);
  return spriteToVM(sprite);
}

export async function deleteVM(client: SpritesClient, name: string): Promise<void> {
  await client.deleteSprite(name);
}
