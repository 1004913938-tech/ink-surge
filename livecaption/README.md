# LiveCaption

主持人说中文，桌面和每位听众手机上实时显示 **中文原文 + 英文 + 印尼语**（听众可自选语言）。
多人会议不乱序，翻译挂了原文照出，听众扫码免登录。架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## 一键启动（需要 Docker）

```bash
cd livecaption
cp .env.example .env            # 填 DEEPGRAM_API_KEY 和 ANTHROPIC_API_KEY
docker compose up -d --build
```

| 服务 | 地址 |
| --- | --- |
| 主持人页 | http://localhost:5173/#/host （API Key 填 `lc_dev_key`） |
| 听众页 | 主持人页上的二维码 / `http://localhost:5173/#/j/<入会码>` |
| API | http://localhost:8000/docs |
| LiveKit | ws://localhost:7880 |

流程：主持人页"开始会议" → 浏览器开麦 → 屏幕出现二维码 + 入会码 → 听众扫码选语言 →
三方（主持人桌面 / 听众手机）同时看到字幕。主持人点"桌面字幕模式"进入大字号全屏，
把窗口放在会议软件上方即可当字幕条。

> 浏览器开麦需要 HTTPS（localhost 除外）。上线时给 web/api/livekit 套一层 TLS（Caddy 两行配置）。

## 本地开发（不用 Docker）

```bash
# Python: core + worker + api
cd livecaption/agent
uv venv && source .venv/bin/activate
uv pip install -e ".[dev]"
pytest                                   # 核心逻辑 + 压力/混沌测试（无需网络）
uvicorn livecaption_api.app:app --reload # API :8000
python -m livecaption_agent.worker dev   # agent（需要 LIVEKIT_* / DEEPGRAM_API_KEY / ANTHROPIC_API_KEY）

# Web
cd livecaption/web
npm install && npm run dev               # :5173
npm test                                 # 字幕合并/排序逻辑测试
```

LiveKit 本地可用 `docker compose up livekit redis`，或 `livekit-server --dev`（dev 模式 key 为 `devkey/secret`）。

## 不花钱先跑通（演示模式）

`.env` 里设 `LC_STT=demo LC_TRANSLATOR=fake`：不需要任何 API Key。只要主持人开着麦克风，agent 每 4 秒
"听到"一句预设中文，翻译输出 `[en] 原文 / [id] 原文`。整条链路（LiveKit → agent → 字幕流 → 主持人页 / 听众手机页）
和正式模式完全一样，只是识别和翻译是假的。

真实联调脚本（需要栈已启动）：

```bash
cd livecaption/agent && python tests/e2e_livekit.py   # Python 客户端：主持人推音频，听众收字幕，断言顺序与译文
```

已在真实 LiveKit + Chromium（假麦克风）上验证：主持人页出二维码，听众页扫码后 2 句内看到中文/英文/印尼语三行，agent 入房延迟 0.2 s。

## 测试覆盖了什么（`agent/tests/`）

- 8 个发言人并发、翻译延迟抖动 → 每个人的字幕顺序正确、无丢失
- 翻译结果乱序返回 → 按说话顺序释放；卡住的段超过窗口后放行并标 `late`
- 翻译服务完全宕机 → 原文零延迟照出，熔断器打开，每段都有 `failed/skipped` 回执
- 30% 随机失败 → 重试，不丢段
- 相同句子只翻一次（缓存 + 并发合并）
- 队列溢出 → 降级为 `skipped`，不堆积
- 500 听众 × 5 语种 × 6 发言人 × 40 句 → 核心处理 < 5 s
- 发言人说到一半掉线 → 自动封口发出

## 目录

```
agent/livecaption_core    纯逻辑（分段、排序、翻译扇出、广播节流）
agent/livecaption_agent   LiveKit worker（音轨 → STT → core → text stream）
agent/livecaption_api     FastAPI（会话、入会码、token、套餐计量）
web/                      主持人控制台 + 听众页（React）
```

## 已知边界 / 下一步

1. **计费**：套餐与分钟计量已实现（SQLite），Stripe/微信支付 webhook 预留（`/billing/stripe/webhook` 返回 501）。
2. **登录**：主持人用 API Key；邮箱 OTP 注册是 Phase 2。
3. **STT 后端**：Deepgram 已接；阿里 Paraformer、sherpa-onnx 本地识别接口已留位（`providers.py`）。
4. **中文识别准确率**：行业术语靠 `glossary`（创建会议时传）+ `LC_DOMAIN_HINT`；需要热词时切 Paraformer。
5. **代理环境**：`livekit-agents` 只读 `HTTPS_PROXY`，不认 `NO_PROXY`。如果机器上设了全局代理，启动 agent 时去掉代理变量，否则连不上本机 LiveKit（报 405）。
6. **已验证范围**：核心单测、LiveKit 真机 e2e（Python 客户端）、Chromium 浏览器 e2e（演示模式）。真实 Deepgram + Claude 的联调需要你的 API Key，尚未跑。
