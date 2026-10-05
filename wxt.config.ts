import { defineConfig } from 'wxt';
export default defineConfig({
    modules: ['@wxt-dev/module-react'],
    manifestVersion: 3,
    manifest: {
        name: 'Shazamski',
        description: 'Identify any playing song against your curated SoundCloud channel. 100% local Chromaprint matching, zero cost.',
        version: '0.1.0',
        permissions: ['storage', 'activeTab', 'tabCapture', 'offscreen'],
        host_permissions: ['https://soundcloud.com/*', 'https://*.soundcloud.com/*'],
        action: {
            default_title: 'Shazamski — identify this song',
        },
        icons: {
            16: '/icons/icon-16.png',
            32: '/icons/icon-32.png',
            48: '/icons/icon-48.png',
            128: '/icons/icon-128.png',
        },
        web_accessible_resources: [
            {
                resources: ['matcher.worker.js'],
                matches: ['<all_urls>'],
            },
        ],
    },
    webExt: {
        disabled: true,
    },
    vite: () => ({
        worker: {
            format: 'es' as const,
        },
    }),
});
