import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { setupTheme } from './app/theme.js'
import { initServerSettings } from './services/settings.js'
import { initServerDrafts } from './services/chat/drafts.js'
import { initChat } from './services/chat/store.js'
import './app/theme.css'
import './app/global.css'

setupTheme()

const start = async () => {
  const root = document.getElementById('root') as HTMLElement
  // 会话列表体积最大：与设置并行拉取，省掉一个往返。
  void initChat()
  try {
    await Promise.all([initServerSettings(), initServerDrafts()])
    createRoot(root).render(<App />)
  } catch {
    root.textContent = '无法加载服务端数据，请检查网络后刷新页面。'
  }
}
void start()
