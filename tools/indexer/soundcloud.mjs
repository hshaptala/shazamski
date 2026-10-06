const API = 'https://api-v2.soundcloud.com';
export async function resolveChannel(channelUrl, clientId) {
    const u = `${API}/resolve?url=${encodeURIComponent(channelUrl)}&client_id=${clientId}`;
    const r = await fetch(u, { headers: { 'User-Agent': 'shazamski-indexer/0.1' } });
    if (!r.ok)
        throw new Error(`resolve failed (${r.status}): ${await r.text().then((t) => t.slice(0, 200))}`);
    const j = await r.json();
    if (j.kind !== 'user' || !j.id) {
        throw new Error(`URL did not resolve to a SoundCloud user (got kind=${j.kind}). Pass the channel profile URL.`);
    }
    return { id: j.id, permalink: j.permalink, username: j.username, trackCount: j.track_count };
}
export async function* listAllTracks(userId, clientId, { pageSize = 200 } = {}) {
    let next = `${API}/users/${userId}/tracks?client_id=${clientId}&limit=${pageSize}&linked_partitioning=1`;
    let total = 0;
    while (next) {
        const r = await fetch(next, { headers: { 'User-Agent': 'shazamski-indexer/0.1' } });
        if (!r.ok)
            throw new Error(`tracks page failed (${r.status})`);
        const j = await r.json();
        const items = j.collection ?? [];
        for (const t of items) {
            total++;
            yield {
                id: t.id,
                title: t.title,
                permalink_url: t.permalink_url,
                artwork_url: t.artwork_url ? t.artwork_url.replace('-large', '-t500x500') : null,
                duration_ms: t.duration ?? 0,
                media: t.media,
                streamable: t.streamable,
            };
        }
        next = j.next_href ? j.next_href.replace(/^http:/, 'https:') : null;
        if (next) {
            next = next.replace(/[?&]client_id=[^&]*/g, (m) => (m[0] === '?' ? '?' : ''));
            next = next.replace(/[?&]$/, '');
            next += (next.includes('?') ? '&' : '?') + `client_id=${clientId}`;
        }
        await new Promise((res) => setTimeout(res, 150));
    }
    void total;
}
export function pickTranscoding(track) {
    const trs = track.media?.transcodings ?? [];
    const prog = trs.find((t) => t.format?.protocol === 'progressive' && /mpeg|mp3/i.test(t.format?.mime_type ?? '') && t.url);
    if (prog)
        return { ...prog, kind: 'progressive' };
    const anyProg = trs.find((t) => t.format?.protocol === 'progressive' && t.url);
    if (anyProg)
        return { ...anyProg, kind: 'progressive' };
    const hls = trs.find((t) => t.format?.protocol === 'hls' && t.url);
    if (hls)
        return { ...hls, kind: 'hls' };
    return null;
}
export async function resolveStreamUrl(transcodingUrl, clientId) {
    const sep = transcodingUrl.includes('?') ? '&' : '?';
    const r = await fetch(`${transcodingUrl}${sep}client_id=${clientId}`, {
        headers: { 'User-Agent': 'shazamski-indexer/0.1' },
        redirect: 'follow',
    });
    if (!r.ok)
        throw new Error(`transcoding resolve failed (${r.status})`);
    const j = await r.json();
    if (!j.url)
        throw new Error('transcoding returned no url');
    return j.url;
}
