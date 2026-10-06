import type { ChannelConfig, IndexMeta } from './types';

function storageArea(): any {
  const api = (globalThis as any).chrome;
  if (!api?.storage?.local) throw new Error('storage.local unavailable');
  return api.storage.local;
}

const KEYS = {
  channelUrl: 'shazamski.channelUrl',
  indexMeta: 'shazamski.indexMeta',
} as const;

export async function getChannelConfig(): Promise<ChannelConfig> {
  const out = await storageArea().get([KEYS.channelUrl]);
  return { channelUrl: (out?.[KEYS.channelUrl] as string) ?? '' };
}

export async function setChannelConfig(cfg: ChannelConfig): Promise<void> {
  await storageArea().set({ [KEYS.channelUrl]: cfg.channelUrl });
}

export async function getIndexMeta(): Promise<IndexMeta | null> {
  const out = await storageArea().get([KEYS.indexMeta]);
  return (out?.[KEYS.indexMeta] as IndexMeta) ?? null;
}

export async function setIndexMeta(meta: IndexMeta): Promise<void> {
  await storageArea().set({ [KEYS.indexMeta]: meta });
}

export async function clearIndexMeta(): Promise<void> {
  await storageArea().remove([KEYS.indexMeta]);
}
