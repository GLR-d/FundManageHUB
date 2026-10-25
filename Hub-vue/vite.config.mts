import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const proxy = {
  '/api': {
    target: 'http://localhost:8080',
    changeOrigin: true,
    rewrite: (path: string) => path.replace(/^\/api(?=\/|$)/, '') || '/'
  }
}

export default defineConfig({
  plugins: [vue()],
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: { host: '127.0.0.1', port: 7070, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 7072, strictPort: true, proxy },
  build: {
    target: 'es2020', manifest: true,
    rolldownOptions: {
      output: {
        // 页面入口名称与重试识别规则一致，保留其余公共分块的默认名称。
        chunkFileNames: chunk => {
          const id = (chunk.facadeModuleId || '').replaceAll('\\', '/')
          const page = id.match(/\/src\/views\/([^/]+)\/index\.vue$/)?.[1]
            || (id.endsWith('/src/layout/index.vue') ? 'layout' : id.endsWith('/src/views/404.vue') ? '404' : '[name]')
          return 'assets/' + page + '-[hash].js'
        }
      }
    }
  }
})
