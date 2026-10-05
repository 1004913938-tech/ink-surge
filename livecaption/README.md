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

## 个人模式：线上会议，只有你看得到（`#/me`）

适合：你在腾讯会议 / Zoom / Teams 里和几个人开会，想看到"每个人说了什么"的中文字幕，别人看不到。

1. 用 **电脑版 Chrome 或 Edge** 打开 `http://localhost:5173/#/me`（Safari / Firefox 拿不到会议声音）。
2. 选"对方说的语言"（不确定就选 **自动识别**）、"字幕翻译成"（默认中文），点 **开始**。
3. 正常进腾讯会议，然后回到本页点 **选择会议声音**：
   - Windows：选「整个屏幕」并打开「同时共享系统音频」（Win11 + Chrome 146+ 也可只选腾讯会议窗口 +「共享应用音频」）。
   - Mac（macOS 14.2+、Chrome 141+）：选「整个屏幕」并打开「同时共享系统音频」，第一次要在 系统设置 → 隐私与安全性 → 录屏与系统录音 里允许 Chrome。
   - 网页版会议：选会议所在标签页并打开「同时共享标签页音频」（所有系统都行）。
4. 字幕按说话人分颜色出现（说话人 1、2、3…）。**点名字可以改成真名**，只存在你电脑上。
5. 点 **悬浮字幕窗**，一个置顶小窗浮在会议软件上方。⚠ 你在会议里共享整个屏幕时别人能看到它，共享前先关掉。

可选：勾选"也显示我自己说的话"会同时识别你的麦克风。建议戴耳机；不戴时 Chrome 141+ 会尽量消掉外放的会议声音，残留的重复句会被自动撤回。

识别服务（`LC_STT`）——个人模式推荐 **Soniox**：

| | Soniox（推荐） | Deepgram |
| --- | --- | --- |
| 一路会议声音里分出 6 个人 | ✔ | ✔（略粗：整句归一个人） |
| 中文/印尼语/英语混说自动识别 | ✔ | ✘ 只能固定一种对方语言 |
| 价格 | ≈ $0.12/小时 | ≈ $0.46/小时 |
| 中国大陆直连 | ✘ 服务器放香港/东京/新加坡 | ✔ |

`demo`：不要任何 Key，模拟 6 个人轮流说印尼语/英语/中文。

说话人分离不会 100% 准确（任何厂商都是）。分错时把两个编号改成同一个名字即可合并显示。

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
cd livecaption/agent && python tests/e2e_livekit.py   # 广播模式：主持人推音频，听众收字幕，断言顺序与译文
cd livecaption/agent && python tests/e2e_personal.py  # 个人模式：6 人会议声音分人分语种、只发给房主、第三者收不到
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
