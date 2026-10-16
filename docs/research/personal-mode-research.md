# 个人模式调研：线上会议分人字幕，只有我看得到

调研日期：2026-10-05。方法：5 个方向并行调研，每条关键结论再由 2 名独立核查员（查官方文档 / 找反例）尝试推翻，共 45 个 agent。
设计落地见 `livecaption/ARCHITECTURE.md` §1、§3a。

## 1. 网页能不能拿到会议声音

| 平台 | 会议客户端（腾讯会议等）的声音 | 网页版会议（标签页） | 置顶悬浮窗（Document PiP） |
| --- | --- | --- | --- |
| Windows 10 + Chrome/Edge | 整个屏幕 +「共享系统音频」（Chrome 74+） | ✔ | ✔ 116+ |
| Windows 11 + Chrome 146+ | 另可只选会议窗口 +「共享应用音频」 | ✔ | ✔ |
| macOS 14.2+ + Chrome 141+（142+ 默认开） | 整个屏幕 +「共享系统音频」，需系统「录屏与系统录音」权限 | ✔ | ✔（会议全屏时被盖住） |
| macOS < 14.2 / Linux（默认） | ✘ | ✔ | ✔ |
| Safari 27 / Firefox 157 | ✘（getDisplayMedia 不返回音频） | ✘ | ✘ / Firefox 151+ |
| 任何浏览器 + 虚拟声卡（BlackHole / VB-CABLE / 立体声混音 / PipeWire Monitor） | ✔（getUserMedia 选该设备） | ✔ | 同上 |

要点（核实后）：
- macOS 上系统录音权限被拒时，Chrome 不报错而是返回一条已结束的音轨 → 必须检查 `readyState`（已实现）。
- getDisplayMedia 必须带视频轨；我们保留 1 fps、不发布。
- 麦克风 `echoCancellation: "all"`（Chrome 141+，仅 Win11 / macOS 14.2+）以系统回环为参考，能消掉腾讯会议客户端外放的声音；普通 `true` 只消 Chrome 自己播放的声音。
- Chromium 全浏览器只有一个画中画窗口（与视频画中画共用），其他网页打开画中画会关掉字幕窗。
- 悬浮窗无法从屏幕共享里排除（网页做不到；Electron 的 `setContentProtection` 在 Windows 10 2004+ 有效，macOS 15+ 无效）。

## 2. 识别服务：一路混音里分出 6 个人 + 中/印/英混说

| 服务 | 实时分人 | 中/印/英自动识别 | 价格（实时） | 结论 |
| --- | --- | --- | --- | --- |
| **Soniox stt-rt-v5**（2026-06-16 GA） | ✔ 逐 token `speaker`（≤15） | ✔ 逐 token `language`，句中切换 | ≈ $0.12/h（含分人、语种）；自带翻译另计 ≈ +$0.06–0.16/h | **选用** |
| Deepgram Nova-3 | ✔ 定稿上整句多数说话人（`diarize=true` 已弃用但可用；推荐 `diarize_model`） | ✘ `multi` 只覆盖 en/es/fr/de/hi/ru/pt/ja/it/nl | $0.46/h 正价（促销 $0.29）+ 分人 $0.12/h | 单语种会议可用 |
| Azure ConversationTranscriber | ✔ | 逐句语言识别（≤10 候选） | ≈ $1.3/h | 唯一有中国大陆区；LiveKit 插件不支持分人 |
| Speechmatics | ✔ 逐段 | ✘ 实时需固定语言包（自动语种模型仍在预览） | — | 观察 |
| AssemblyAI U3.6 Pro | ✔ 每轮一个说话人 | 无印尼语 | $0.45 + $0.12/h | 不适用 |
| Gladia / ElevenLabs / 阿里 Fun-ASR / 通义听悟 / 腾讯 | 无实时分人或无印尼语 | — | — | 不适用 |

要点：
- Soniox 无中国大陆节点（US/EU/JP/IN），key 按区域绑定 → agent 部署在香港/东京/新加坡，`LC_SONIOX_URL` 指向 JP。
- LiveKit 插件 1.8.4 全部不会在定稿里按说话人切句；Soniox 插件只取首个 token 的说话人 → 我们打了补丁（`soniox_patch.py`）按 (说话人, 语种) 切分。
- 任何服务在混音里分人都会错（第三方测得 Soniox 实时 DER 40%+），说话人标签会在早期翻转；每次重连会从头编号 → 我们按连接代命名空间。

## 3. 竞品做法（可借鉴的 UX）

- 会议软件自带翻译字幕（腾讯会议 17 语种含印尼语、Teams、Zoom、Meet）都是"仅自己可见 + 有真名"，但要**主持人/组织者**有付费套餐，且主持人可关闭——参会的中国销售常常用不上，这是本产品的空间。
- 第三方工具（Granola 等）大多只按来源分"我 / 他们"，不在实时字幕里分远端的人；能分人的（Otter、Krisp、Transync、讯飞角色分离）多是会后改名。
- 不戴耳机的回声是行业通病（开源 quill：42 分钟会议里 641 句"我"有 477 句是回声）。主流做法：时间重叠 + 文本相似度去重，或系统回环做参考的回声消除。
- 布局共识：说话人名 + 语种标签；原文/译文双语；字号可调；可弹出置顶小窗；译文放上面避免视线跳动。

## 主要来源

- Chromium 源码：`desktop_media_picker_controller.cc`、`media_switches.cc`、`media_stream_audio_processor_options.cc`（github.com/chromium/chromium）
- MDN browser-compat-data 8.1.4（2026-10-01）；WICG Document Picture-in-Picture 规范
- Electron 文档：session.md、desktop-capturer.md、breaking-changes.md；Apple Core Audio taps 示例（insidegui/AudioCap、makeusabrew/audiotee）
- Soniox：soniox.com/blog/soniox-v5-real-time、/pricing、/docs（speaker-diarization、websocket-api、rt-translation）；Soniox Python SDK 2.10.0
- Deepgram：deepgram/deepgram-api-specs（asyncapi.yml）、models-languages-overview、deepgram/skills CHANGELOG（2026-10-02）
- LiveKit Agents 1.8.4 插件源码（deepgram、soniox、speechmatics、assemblyai、azure、gladia、elevenlabs）
- 腾讯会议帮助中心（实时字幕/翻译）；Granola、Otter、Krisp 帮助文档；quill issue #56
