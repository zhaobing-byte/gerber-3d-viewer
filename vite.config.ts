import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    watch: {
      ignored: [
        // footprint 下的压缩包可能正在被其它进程写入，监听会触发 EBUSY 并让开发服务器崩溃。
        '**/*.zip',
        '**/*.7z',
        '**/*.rar',
        '**/*.tar',
        '**/*.gz',
        // 本机模型库由 Python API 动态读取，不参与 Vite 构建或监听。批量铺库时忽略整树，
        // 避免数千个 STEP 文件触发 HMR 文件事件；页面可通过模型目录 API 立即重新读取清单。
        '**/footprint/3dmodels/**',
      ],
    },
    proxy: {
      '/api/kingdee': 'http://127.0.0.1:8765',
      '/api/footprint': 'http://127.0.0.1:8765',
    },
  },
})
