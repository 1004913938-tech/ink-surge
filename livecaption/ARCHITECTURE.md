# LiveCaption — 架构与产品决策

> 产品一句话：主持人说中文，桌面上和每个听众手机上实时显示 **中文原文 / 英文 / 印尼语**（或听众自选语言）。多人开会也不乱。按订阅收费。

状态：MVP 开发中（2026-10）。本文件是决策记录，改架构先改这里。

---

## 1. 选型结论（为什么是 LiveKit）

| 候选 | 星数 / 许可证 | 结论 |
| --- | --- | --- |
| **LiveKit server + LiveKit Agents** | 13.5k★ / Apache-2.0，1.0 于 2025-04，生产使用广泛 | **选用。** WebRTC SFU，每个参会者一条独立音轨，天生解决"多人同时说话混在一起"的问题；Agents 框架提供 STT 插件体系、worker 进程隔离、负载均衡；Data/Text Stream 原生支持向 N 个听众广播文本。 |
| g0v/OpenTransLive | 38★ / AGPL-3.0，单人维护 | 产品形态最像，但不成熟、AGPL 不利于闭源 SaaS。只借鉴产品设计。 |
| WhisperLiveKit | 活跃 / MIT | 好引擎，但只是 ASR 服务端，没有房间/多人/广播概念。后续可作本地 STT 后端。 |
| sherpa-onnx | 15k★ / Apache-2.0 | 离线中文识别（SenseVoice/Paraformer）首选，Phase 2 作为私有化部署的 STT 后端。 |

STT 选型（可插拔，环境变量切换）：

| 后端 | 中文 | 印尼语 | 延迟 | 用途 |
| --- | --- | --- | --- | --- |
| Deepgram Nova-3（已接入） | zh / zh-CN / zh-TW | id | < 300 ms | 默认云端 |
| 阿里 Paraformer 实时（接口预留） | 最强 | — | 低 | 中文为主的客户 |
| sherpa-onnx 本地（接口预留） | SenseVoice | — | CPU 可跑 | 私有化/涉密 |

翻译：LLM（Claude `claude-opus-5-5`，`effort=low` 保证延迟），**一次调用同时产出所有目标语言**，结构化 JSON 输出；接口可插拔（`Translator` 协议）。

---

## 2. 系统拓扑

```
 主持人浏览器 ──mic──▶ ┌──────────────┐ ◀──text stream── 听众手机 ×N（扫码，免登录）
 (桌面三行字幕)        │ LiveKit SFU  │
                       └──────┬───────┘
                   每个发言人一条音轨 │ 订阅全部音轨
                       ┌──────▼───────┐
                       │ Caption Agent│  livekit-agents worker（每房间一个 job 进程）
                       │  ┌─────────┐ │
                       │  │SpeakerLane│×每位发言人：STT 流 → 分段 → 序号
                       │  └────┬────┘ │
                       │  TranslationHub：去重缓存 / 并发限制 / 超时 / 熔断
                       │       │      │
                       │   Broadcaster：节流 + send_text(topic="lc.caption")
                       └──────────────┘
 ┌──────────────┐
 │ API (FastAPI)│  创建会话 / 签发 token / 入会码 / 套餐分钟数 / Stripe webhook
 └──────────────┘
```

角色与权限（全部由 JWT 决定，听众**无法**发音频或数据）：

| 角色 | can_publish | can_subscribe | can_publish_data | 属性 |
| --- | --- | --- | --- | --- |
| host（主持人） | ✔ | ✔ | ✔ | `lc.role=speaker`, `lc.lang=zh` |
| speaker（其他发言人） | ✔ | ✔ | ✘ | `lc.role=speaker` |
| listener（听众） | ✘ | ✔ | ✘ | `lc.langs=en,id`（自选，可改） |
| agent | ✘ | ✔ | ✔ | LiveKit `agent` kind |

---

## 3. "多人不乱"的核心设计

问题：多人同时说话、STT 乱序返回、翻译有快有慢，字幕屏幕上会交错、错位、覆盖。

解决：**字幕消息不靠到达顺序排序，靠键排序。**

1. **每个发言人独立 Lane**。音轨天然分离（SFU 不混音），每条音轨一条 STT 流，互不影响。
2. **分段编号 `(speaker_id, seq)`**：Lane 内 `seq` 严格单调递增，`segment_id` 全局唯一。
   - interim（临时）结果只更新当前打开的段，不新建段；
   - final 结果封口该段，`seq+1` 开新段。
3. **原文先发，译文后补（patch）**：final 原文立即广播（`kind=final`），译文到达后发 `kind=patch`，带同一 `segment_id`。客户端按 `segment_id` 合并。慢翻译不会卡住后面的原文。
4. **Lane 内译文按序释放**：若 seq=5 的译文先于 seq=4 到达，Hub 会等待 seq=4 最多 `reorder_window_ms`（默认 1500ms），超时则放行并标记 `late`。保证读者看到的译文顺序和说话顺序一致。
5. **客户端渲染规则**：按 `speaker_id` 分组 → 组内按 `seq` 排序 → 同 `segment_id` 的消息后者覆盖前者。任何重复/乱序投递都幂等。
6. **节流**：interim 每 lane 最多 4 条/秒；500 个听众 × 4 Hz × 8 发言人 = 16k msg/s 上限，由 SFU 扇出，agent 只发一份（`send_text` 不指定 destination → 房间广播）。

### 退化策略（抗压）

| 故障 | 行为 |
| --- | --- |
| 翻译 API 超时/5xx | 重试 1 次（指数退避），仍失败 → 该段标 `tr_status=failed`，原文照常显示；熔断器连续 5 次失败后 30s 内直接跳过翻译，只出原文 |
| 翻译排队积压 | 并发上限（默认 8）+ 队列上限（默认 64 段）；超限丢弃**最旧的 interim**，final 永不丢 |
| STT 断流 | Lane 自动重建 STT 流（指数退避），旧段封口 |
| 某发言人静音/离开 | Lane 关闭，封口最后一段 |
| 听众语言变化 | 属性变更事件 → 更新语言需求集合；没人要的语言不翻（省钱） |
| agent 进程崩溃 | livekit-agents worker 重新派发 job；客户端收到 `kind=reset` 清屏重来 |

---

## 3a. 个人模式（`#/me`）：线上会议，只有我看得到

场景：我在腾讯会议 / Zoom / Teams 里和 6 个人开会，别人说印尼语、英语、中文，我要看到"谁说了什么"的中文字幕，别人看不到。

```
腾讯会议客户端 / 网页版 ──扬声器──▶ 我的耳朵
        │ 系统声音 / 应用声音 / 标签页声音（getDisplayMedia）
        ▼
 我的 Chrome（#/me）──▶ LiveKit 私人房间 ──▶ agent
   ├ 音轨 A：screen_share_audio = 会议声音（别人）  → STT 说话人分离 + 自动语种 → 说话人 1..N
   └ 音轨 B（可选）：microphone = 我              → 已知说话人"我"，回声去重
        ◀── 字幕只发给房主（send_text destination_identities=[owner]）
 Document Picture-in-Picture 悬浮窗（置顶，浮在会议软件上方）
```

关键设计：

1. **按音轨建管道**，不是按参会者：同一个人可同时推"麦克风"和"会议声音"两条音轨，agent 按 `TrackSource` 区分。
2. **说话人分离在 core 里做归属**（`CaptionSession.on_track_*`）：
   - 多数 STT 只在 final 上给说话人。interim 先挂在占位"会议声音"下显示；final 到达时**复用同一 sid** 改挂到"说话人 N"，客户端原地替换，不闪不跳。
   - STT 标签（S0 / "1" / "A"）→ 每条音轨按首次出现编号"说话人 1..N"。改名只在本机（localStorage），不上传。
   - 一个 final 跨了说话人（带逐词说话人时）→ 按词切成多条 final（`word_runs`）。Soniox 插件原生只取首个说话人，`soniox_patch.py` 补齐逐 token 说话人。
3. **按句语种**：会议声音设为 `auto`，STT 每句给语种；只翻成"我要看的语言"里与原文不同的那些（中文发言不翻）。
4. **回声**：没戴耳机时麦克风会听到会议声音。三层防护：
   - 我的麦克风默认**不开**（自己的话自己知道）；
   - 开麦时用 `echoCancellation: "all"`（Chrome 141+，Win11 / macOS 14.2+ 用系统回环做参考，能消掉腾讯会议客户端的外放）；
   - core 做文本相似度去重：麦克风 final 先压 1 秒，期间会议声音出现相似句则丢弃；已显示的发 `retract` 撤回。
5. **隐私**：房间 `max_participants=3`，agent 只给房主发字幕（e2e 测试验证：拿到同房间 token 的第三者收到 0 条）；个人会话不能用入会码查到。悬浮窗无法从屏幕共享中排除，界面提示"共享屏幕前先关悬浮窗"。

浏览器能力（2026-10 调研，详见 `docs/research/`）：

| 平台 | 会议客户端的声音 | 网页版会议（标签页） | 悬浮窗 |
| --- | --- | --- | --- |
| Windows 10/11 + Chrome/Edge | 整个屏幕 +「共享系统音频」；Win11 + Chrome 146+ 可只选会议窗口 | ✔ | ✔ 116+ |
| macOS 14.2+ + Chrome 141+ | 整个屏幕 +「共享系统音频」（需系统录音权限） | ✔ | ✔（会议软件全屏时会被盖住） |
| macOS < 14.2 | ✘（只能用网页版会议） | ✔ | ✔ |
| Safari / Firefox | ✘ | ✘ | ✘ / Firefox 151+ |

不满足时的兜底：Electron 桌面壳（Windows `audio:'loopback'`，macOS Core Audio process tap），估算 1–1.5 周，未实现。

---

## 4. 消息协议（text stream，topic `lc.caption`，JSON）

```jsonc
{
  "v": 1,
  "kind": "interim" | "final" | "patch" | "reset" | "retract",
  "sid": "s_7f3a",            // segment_id
  "spk": {"id": "host-1", "name": "张总"},
  "seq": 42,
  "src": {"lang": "zh", "text": "我们下季度的目标是……"},
  "tr": {"en": "Our goal for next quarter is…", "id": "Target kami untuk kuartal depan adalah…"},
  "tr_status": "ok" | "pending" | "failed" | "late",
  "t": 1733212345.12          // agent 时间戳
}
```

- `interim`：`src` 可变，`tr` 一般为空（可选"快速译文"）。
- `final`：`src` 定稿；`tr` 可能为空（随后 `patch`）。
- `patch`：只带 `sid` + `tr` + `tr_status`。
- `reset`：agent 重启或会话切换，客户端清空。
- `retract`：撤回一行（回声重复、或 STT 放弃的临时句）。客户端删除该 sid，并忽略它之后的任何消息。
- 个人模式下，同一 sid 的 interim 与 final 的 `spk` 可以不同（占位"会议声音" → "说话人 N"），客户端以 final 为准。

---

## 5. 订阅/商业化模型（Phase 2 实现，接口已留）

- 账户：邮箱 OTP 登录（主持人），听众免登录。
- 套餐：按**会议分钟数/月**（例：Free 60 分钟、Pro 1500 分钟、Team 10000 分钟）+ 最大听众数 + 语种数。
- 计量：agent 每 60s 上报房间活跃分钟 → API 扣减；超额自动停翻译、保留原文、提示升级。
- 支付：Stripe（海外）/ 微信支付（国内）webhook → 更新套餐。
- 单租户数据隔离：房间名 = `lc_{account}_{session}`，token 只授权本房间。

---

## 6. 目录结构

```
livecaption/
├── ARCHITECTURE.md          ← 本文件
├── README.md                ← 运行手册
├── docker-compose.yml       ← livekit + redis + api + agent + web
├── livekit.yaml
├── agent/                   ← Python：核心逻辑 + LiveKit worker + API
│   ├── pyproject.toml
│   ├── livecaption_core/    ← 纯逻辑，无 I/O，可单测、可压测
│   ├── livecaption_agent/   ← LiveKit worker（音轨 → STT → core → text stream）
│   ├── livecaption_api/     ← FastAPI：会话、token、入会码、套餐
│   └── tests/               ← 单元 + 压力/混沌测试
└── web/                     ← Vite + React：主持人控制台 / 听众页
```

---

## 7. 验收标准（交付前必须全绿）

- [ ] `pytest` 全部通过，含：8 发言人并发、STT 乱序、翻译随机失败/超时、500 听众扇出、5 语种。
- [ ] 任意一条 Lane 内译文顺序 == 原文顺序（测试断言）。
- [ ] 翻译后端完全宕机时，原文字幕延迟不增加（测试断言）。
- [ ] `docker compose config` 校验通过；`docker compose up` 一键起全栈（需要有 Docker 的机器）。
- [ ] 主持人页三行字幕（zh/en/id）；听众页扫码 3 秒内上屏。
