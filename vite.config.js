import { defineConfig } from 'vite';

export default defineConfig({
    root: 'renderer',
    base: './',
    server: {
        port: 5173,
        strictPort: true,
    },
    build: {
        outDir: '../dist/renderer',
        emptyOutDir: true,
    },
});
