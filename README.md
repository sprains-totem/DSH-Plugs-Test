# DSH-Plugs-Test

自动化测试与端到端 Chrome DevTools Protocol (CDP) 验证仓库，针对以下两个独立的 DeepSeek Harness 插件仓库进行持续集成与全链路测试：

1. 🌌 **[sprains-totem/dsh-Antigravity-Provider](https://github.com/sprains-totem/dsh-Antigravity-Provider)**
   - `dsh-llm-antigravity` (Gemini 3.7 Flash LLM Adapter)
   - `dsh-web-search-antigravity` (Google Grounding Web Search)
   - `dsh-web-search-selector` (Search Provider Switcher)
   - `dsh-image-gen-antigravity` (Gemini 3.1 Flash Image Generation)

2. 📦 **[sprains-totem/dsh-CloudFlare-Tunnel](https://github.com/sprains-totem/dsh-CloudFlare-Tunnel)**
   - `dsh-cloudflare-tunnel` (Cloudflare Quick/Named Tunnel & Worker Router)

---

## 🧪 测试内容与自动化验证项

工作流通过 Headless Chrome 与 Chrome DevTools Protocol 自动化执行以下端到端验证：

1. **服务启动与客户端注册**：验证 `window.__DSH_BOOT__` 成功注入并加载 `dsh-llm-antigravity` 与 `dsh-web-search-selector` 客户端模块；
2. **模型配置面板**：
   - 验证 Antigravity 提供方卡片正常呈现并显示已配置状态；
   - 验证点击「编辑」按钮后正确弹出 Refresh Token 输入框（标签为 `Refresh Token`，占位符为 `Refresh Token 已配置（留空保持不变）` / `请输入 OAuth 2.0 Refresh Token`）；
3. **插件配置面板**：
   - 验证 `Antigravity (Google Cloud Code)` 独立配置卡片正常渲染；
   - 验证 `网页搜索源 (web-search-selector)` 卡片正常渲染，并支持自由切换搜索源；
4. **测试截图产物**：自动捕获全链路 5 张高分辨率截图并作为 GitHub Actions Artifact 保存。
