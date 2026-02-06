import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createSpritesClient, spriteToVM, generateVMName, listVMs, createVM, deleteVM } from '../sprites-client.js';

describe('sprites-client', () => {
  const originalToken = process.env.SPRITES_TOKEN;

  afterEach(() => {
    if (originalToken) {
      process.env.SPRITES_TOKEN = originalToken;
    } else {
      delete process.env.SPRITES_TOKEN;
    }
  });

  it('should throw if SPRITES_TOKEN is not set', () => {
    delete process.env.SPRITES_TOKEN;
    expect(() => createSpritesClient()).toThrow('SPRITES_TOKEN environment variable is required');
  });

  it('should create client when SPRITES_TOKEN is set', () => {
    process.env.SPRITES_TOKEN = 'test-token';
    const client = createSpritesClient();
    expect(client).toBeDefined();
    expect(client.token).toBe('test-token');
  });
});

describe('generateVMName', () => {
  it('should generate name with pigs- prefix', () => {
    const name = generateVMName();
    expect(name.startsWith('pigs-')).toBe(true);
  });

  it('should generate 6-char alphanumeric suffix', () => {
    const name = generateVMName();
    const suffix = name.slice(5);
    expect(suffix).toHaveLength(6);
    expect(suffix).toMatch(/^[a-z0-9]+$/);
  });

  it('should generate unique names', () => {
    const names = new Set<string>();
    for (let i = 0; i < 20; i++) {
      names.add(generateVMName());
    }
    // With 36^6 possibilities, 20 names should all be unique
    expect(names.size).toBe(20);
  });
});

describe('spriteToVM', () => {
  it('should map sprite with all fields', () => {
    const sprite = {
      name: 'pigs-abc123',
      id: 'uuid-123',
      status: 'running',
      createdAt: new Date('2026-01-15T10:00:00Z'),
      client: {} as any,
    } as any;

    const vm = spriteToVM(sprite);
    expect(vm).toEqual({
      name: 'pigs-abc123',
      id: 'uuid-123',
      status: 'running',
      createdAt: '2026-01-15T10:00:00.000Z',
      needsAttention: false,
      displayLabel: 'abc123',
    });
  });

  it('should use name as fallback for missing id', () => {
    const sprite = {
      name: 'pigs-xyz',
      id: undefined,
      status: 'cold',
      createdAt: new Date('2026-01-15T10:00:00Z'),
      client: {} as any,
    } as any;

    const vm = spriteToVM(sprite);
    expect(vm.id).toBe('pigs-xyz');
  });

  it('should default to cold status when status is undefined', () => {
    const sprite = {
      name: 'pigs-xyz',
      id: 'id-1',
      status: undefined,
      createdAt: new Date('2026-01-15T10:00:00Z'),
      client: {} as any,
    } as any;

    const vm = spriteToVM(sprite);
    expect(vm.status).toBe('cold');
  });

  it('should set displayLabel to last 6 chars of name', () => {
    const sprite = {
      name: 'pigs-abc123',
      id: 'uuid-123',
      status: 'running',
      createdAt: new Date('2026-01-15T10:00:00Z'),
      client: {} as any,
    } as any;

    const vm = spriteToVM(sprite);
    expect(vm.displayLabel).toBe('abc123');
  });

  it('should use current time as fallback when createdAt is undefined', () => {
    const before = new Date().toISOString();
    const sprite = {
      name: 'pigs-xyz',
      id: 'id-1',
      status: 'running',
      createdAt: undefined,
      client: {} as any,
    } as any;

    const vm = spriteToVM(sprite);
    const after = new Date().toISOString();
    expect(vm.createdAt >= before).toBe(true);
    expect(vm.createdAt <= after).toBe(true);
  });
});

describe('listVMs', () => {
  it('should list VMs with pigs- prefix filter', async () => {
    const mockSprites = [
      { name: 'pigs-abc', id: 'id-1', status: 'running', createdAt: new Date('2026-01-15T10:00:00Z'), client: {} },
      { name: 'pigs-def', id: 'id-2', status: 'cold', createdAt: new Date('2026-01-15T11:00:00Z'), client: {} },
    ];
    const mockClient = {
      listAllSprites: vi.fn().mockResolvedValue(mockSprites),
    } as any;

    const vms = await listVMs(mockClient);

    expect(mockClient.listAllSprites).toHaveBeenCalledWith('pigs-');
    expect(vms).toHaveLength(2);
    expect(vms[0].name).toBe('pigs-abc');
    expect(vms[0].status).toBe('running');
    expect(vms[1].name).toBe('pigs-def');
    expect(vms[1].status).toBe('cold');
  });

  it('should return empty array when no VMs exist', async () => {
    const mockClient = {
      listAllSprites: vi.fn().mockResolvedValue([]),
    } as any;

    const vms = await listVMs(mockClient);
    expect(vms).toEqual([]);
  });
});

describe('createVM', () => {
  it('should create VM with generated name when no name provided', async () => {
    const mockSprite = {
      name: 'pigs-abc123',
      id: 'new-id',
      status: 'cold',
      createdAt: new Date('2026-01-15T12:00:00Z'),
      client: {},
    };
    const mockClient = {
      createSprite: vi.fn().mockResolvedValue(mockSprite),
    } as any;

    const vm = await createVM(mockClient);

    expect(mockClient.createSprite).toHaveBeenCalledTimes(1);
    const calledName = mockClient.createSprite.mock.calls[0][0];
    expect(calledName.startsWith('pigs-')).toBe(true);
    expect(vm.name).toBe('pigs-abc123');
    expect(vm.status).toBe('cold');
  });

  it('should create VM with explicit name when provided', async () => {
    const mockSprite = {
      name: 'pigs-custom',
      id: 'new-id',
      status: 'cold',
      createdAt: new Date('2026-01-15T12:00:00Z'),
      client: {},
    };
    const mockClient = {
      createSprite: vi.fn().mockResolvedValue(mockSprite),
    } as any;

    const vm = await createVM(mockClient, 'pigs-custom');

    expect(mockClient.createSprite).toHaveBeenCalledWith('pigs-custom');
    expect(vm.name).toBe('pigs-custom');
  });
});

describe('deleteVM', () => {
  it('should delete VM by name', async () => {
    const mockClient = {
      deleteSprite: vi.fn().mockResolvedValue(undefined),
    } as any;

    await deleteVM(mockClient, 'pigs-abc123');
    expect(mockClient.deleteSprite).toHaveBeenCalledWith('pigs-abc123');
  });
});
