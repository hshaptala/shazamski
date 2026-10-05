import type { ChannelConfig, IndexMeta } from './types';
declare const chrome: any | undefined;
function storageArea(): any {
    const api = (globalThis as any).chrome;
    if (!api?.storage?.local)
        throw new Error('storage.local unavailable');
    return api.storage.local;
}
const KEYS = {
    channelUrl: 'shazamski.channelUrl',
    indexMeta: 'shazamski.indexMeta',
} as const;
export async function getChannelConfig(): Promise<ChannelConfig> {
    const area = storageArea();
    const out = await area.get([KEYS.channelUrl]);
    return { channelUrl: (out?.[KEYS.channelUrl] as string) ?? '' };
}
export async function setChannelConfig(cfg: ChannelConfig): Promise<void> {
    const area = storageArea();
    await area.set({ [KEYS.channelUrl]: cfg.channelUrl });
}
export async function getIndexMeta(): Promise<IndexMeta | null> {
    const area = storageArea();
    const out = await area.get([KEYS.indexMeta]);
    return (out?.[KEYS.indexMeta] as IndexMeta) ?? null;
}
export async function setIndexMeta(meta: IndexMeta): Promise<void> {
    const area = storageArea();
    await area.set({ [KEYS.indexMeta]: meta });
}
export async function clearIndexMeta(): Promise<void> {
    const area = storageArea();
    await area.remove([KEYS.indexMeta]);
}
