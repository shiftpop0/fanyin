import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const proxyTarget = env.VITE_DEV_PROXY_TARGET || 'http://127.0.0.1:8885'

  return {
    plugins: [react()],
    build: {
      // Ant Design is the only UI dependency; its single-page vendor payload is
      // intentionally accepted up to this audited threshold.
      chunkSizeWarningLimit: 1100,
    },
    server: {
      proxy: {
        '/health': proxyTarget,
        '/v1': proxyTarget,
      },
    },
  }
})
