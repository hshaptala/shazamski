export function normalizeChannelUrl(input: string): string {
  const v = input.trim().replace(/\/+$/, '');
  const m = v.match(/^https:\/\/(www\.|m\.)?soundcloud\.com\/([A-Za-z0-9_-]+)(?:\/.*)?$/);
  if (!m) return v;
  return `https://soundcloud.com/${m[2]}`;
}

export function isSoundCloudChannelUrl(input: string): boolean {
  return /^https:\/\/(www\.|m\.)?soundcloud\.com\/[A-Za-z0-9_-]+\/?$/.test(input.trim());
}
