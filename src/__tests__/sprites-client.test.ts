import { describe, it, expect } from 'vitest';
import { createSpritesClient } from '../sprites-client.js';

describe('sprites-client', () => {
  it('should throw if SPRITES_TOKEN is not set', () => {
    const original = process.env.SPRITES_TOKEN;
    delete process.env.SPRITES_TOKEN;
    expect(() => createSpritesClient()).toThrow('SPRITES_TOKEN environment variable is required');
    if (original) process.env.SPRITES_TOKEN = original;
  });
});
