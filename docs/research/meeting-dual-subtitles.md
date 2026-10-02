# 会议场景桌面双字幕翻译 — 产品与开源项目调研

调研日期：2026-10-02

**需求**：开会时（腾讯会议 / 飞书 / Zoom / Teams 等，或线下会议）在桌面上实时显示两路字幕。
"两种字幕"有两种理解，下文都覆盖：

- **A. 原文 + 译文**（双语对照，最常见）
- **B. 两种目标语言同时显示**（例如原声英文，同时显示中文 + 日文）

## 一、结论速览

| 你的情况 | 推荐 |
| --- | --- |
| 想马上用、不折腾，只在一个会议软件里 | 会议软件自带的翻译字幕（腾讯会议 / 飞书 / Teams / Zoom） |
| 跨会议软件、桌面悬浮、原文+译文，愿意付费 | 讯飞同传、百度 AI 同传桌面助手、Transync AI |
| 想要开源、Windows、免费、悬浮双语字幕 | **LiveCaptions-Translator**（成熟度最高） |
| 想要开源、跨平台、会议双向互译 | **Sokuji** |
| 要做"同时两种目标语言"或二次开发 | 基于 **WhisperLiveKit** 或 **fmadore/Live-translation** 改造 |

## 二、成熟商业产品

| 产品 | 形态 | 双语字幕 | 备注 |
| --- | --- | --- | --- |
| 腾讯会议 实时翻译 | 会议内置 | 原文+译文 | 2026 年 6 月更新，商业版/企业版，中英互译为主 |
| 飞书会议 / 妙记 | 会议内置 | 原文+译文 | 会后自动生成纪要到飞书文档 |
| Microsoft Teams 实时翻译字幕 | 会议内置 | 每人可选自己的字幕语言 | 需 Teams Premium / Copilot 许可 |
| Zoom Translated Captions | 会议内置 | 每人可选字幕语言 | 需付费附加功能 |
| 讯飞同传（电脑版） | 独立桌面应用 | 原文+译文悬浮窗 | 采集系统音频，任意会议软件可用，中文场景识别强 |
| 百度 AI 同传 桌面同传助手 | 独立桌面应用 | 原文+译文 | 面向会议场景 |
| Transync AI | 桌面/移动 | 原文+译文 | 主打低延迟同传 |
| 沉浸式翻译 Immersive Translate | 浏览器插件 | 原文+译文 | 仅限网页版 Zoom / Meet / Teams，依赖平台自身字幕 |

要点：
- **会议内置方案**最稳定，但只在该会议软件内有效，通常每个人只能选一种字幕语言 → 满足 A，不满足 B。
- **独立桌面同传应用**（讯飞、百度）通过采集系统声音工作，与会议软件无关，桌面悬浮显示，是"桌面双字幕"最贴合的成熟产品。

## 三、开源项目

| 项目 | 平台 | 识别 / 翻译 | 特点 | 成熟度 |
| --- | --- | --- | --- | --- |
| [SakiRinn/LiveCaptions-Translator](https://github.com/SakiRinn/LiveCaptions-Translator) | Windows 11 | 调用 Windows 自带"实时辅助字幕"识别 + 可选 Google / DeepL / OpenAI / Ollama 等翻译 | 轻量，悬浮窗双语字幕，系统音频/麦克风均可，社区 fork 很多 | ★★★★ 最成熟 |
| [getfine333-ux/LiveCaptions-Translator](https://github.com/getfine333-ux/LiveCaptions-Translator)（上面的衍生版） | Windows 11 | 本地 sherpa-onnx 识别（CPU 即可） | 句子级稳定字幕、可编辑术语表（适合行业会议） | ★★★ |
| [kizuna-ai-lab/sokuji](https://github.com/kizuna-ai-lab/sokuji) | Win / macOS / Linux + Chrome/Edge 插件 | 云端（OpenAI 等）或完全离线 | 专为双语会议设计：自动检测语种、双向互译，适配 Zoom/Meet/Teams | ★★★ |
| [RuizhangZhou/talkecho](https://github.com/RuizhangZhou/talkecho) | 桌面 | 可选 Groq / OpenAI / Anthropic / Ollama | 半透明悬浮窗，同时采集系统音频 + 麦克风，双语字幕 | ★★ |
| [fmadore/Live-translation](https://github.com/fmadore/Live-translation) | Tauri 桌面（主要 Windows） | Gemini / OpenAI / Mistral 实时语音模型 | 为学术会议做的透明置顶悬浮窗，同时有"翻译字幕 + 同语字幕" | ★★ 新项目 |
| [rioX432/live-translate](https://github.com/rioX432/live-translate) | 桌面 | 本地 GPU | 日↔英演讲/会议悬浮字幕 | ★★（语言对受限） |
| [HaiHoang-AI/Real-Time-Translator](https://github.com/HaiHoang-AI/Real-Time-Translator) | PC | 本地 | 系统音频→悬浮翻译字幕，可配音 | ★★ |
| Mac Live Subtitle / VRT | macOS | 多种 ASR + 翻译后端 | macOS 实时转写+双语字幕，MIT 协议 | ★★ |
| [QuentinFuxa/WhisperLiveKit](https://github.com/QuentinFuxa/WhisperLiveKit) | 服务端 + Web UI | 本地流式 Whisper，200+ 语言 | **引擎而非成品**：流式识别、说话人分离、翻译、术语上下文；适合二次开发 | ★★★★（作为引擎） |
| [joelorzet/transcribe-live](https://github.com/joelorzet/transcribe-live) | Web / OBS 叠加层 / 终端 | — | 会议现场西英字幕投屏 | ★★ |

## 四、关于"两种目标语言同时显示"（需求 B）

现成产品基本只做"原文 + 一种译文"。要实现两种译文：

1. **最省事**：同时开两个实例（例如 LiveCaptions-Translator 开两个窗口，分别设置目标语言 中文 / 日文），上下摆放。
2. **开发方案**（推荐架构，一次识别、多路翻译）：

```
系统音频(WASAPI loopback / BlackHole) + 麦克风
        │
  流式 ASR（WhisperLiveKit / sherpa-onnx / 云端 ASR）
        │  原文句段
   ┌────┴────┐
 翻译→语言1  翻译→语言2   （LLM 或 DeepL，带行业术语表）
   └────┬────┘
 透明置顶悬浮窗（Tauri / Electron），三行：原文 / 译文1 / 译文2
```

   `fmadore/Live-translation`（Tauri 悬浮窗）或 `Sokuji` 是最好的改造起点。

## 4.1 已确认需求：说中文 → 同时显示 中文原文 / 英文 / 印尼语

现成产品里没有确认能"一个窗口同时出英文 + 印尼语"的（讯飞实时翻译公开语种列表不含印尼语；会议内置字幕每人只能选一种语言）。可行方案：

| 方案 | 做法 | 成本 |
| --- | --- | --- |
| 零开发 | 开两个 LiveCaptions-Translator（getfine333 衍生版，本地中文识别）实例，目标语言分别设英文、印尼语，上下摆放 | 免费；两次识别，两个窗口可能不同步 |
| **推荐：小工具** | **Azure Speech 语音翻译**：单次 API 调用即可 `zh-CN` → `en` + `id` 两种目标语言（官方限制单次最多两种，正好满足），返回原文 + 两路译文；做一个透明置顶悬浮窗显示三行 | 按用量付费；延迟约 1 秒；一次识别，三行同步 |
| 本地/保密 | sherpa-onnx（SenseVoice/Paraformer 中文识别）+ 本地 LLM（Ollama）同时翻译英文、印尼语 | 免费；需较好硬件，印尼语质量取决于模型 |

参考：[Azure 语音翻译概述（多目标语言）](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation)、[语言支持（含印尼语 id）](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support)

## 五、行业会议的选型建议

- **术语准确度**是工业/行业会议的关键：优先选支持术语表/热词的方案（讯飞同传热词、getfine333 版 LiveCaptions-Translator 术语表、LLM 翻译加 system prompt 术语）。
- **数据安全**：涉密会议用本地识别 + 本地 LLM（Ollama），可选 sherpa-onnx / WhisperLiveKit。
- **中文识别**：中文为主的会议，讯飞、SenseVoice、Paraformer（sherpa-onnx 支持）效果优于原版 Whisper。
- **延迟**：云端实时语音模型（OpenAI Realtime、Gemini Live）约 1 秒内；本地 Whisper 流式约 1–3 秒。

## 来源

- https://github.com/SakiRinn/LiveCaptions-Translator
- https://github.com/getfine333-ux/LiveCaptions-Translator
- https://github.com/kizuna-ai-lab/sokuji
- https://github.com/RuizhangZhou/talkecho
- https://github.com/fmadore/Live-translation
- https://github.com/rioX432/live-translate
- https://github.com/HaiHoang-AI/Real-Time-Translator
- https://github.com/QuentinFuxa/WhisperLiveKit
- https://github.com/joelorzet/transcribe-live
- https://zhuanlan.zhihu.com/p/2010057084230727509 （Mac Live Subtitle）
- https://www.v2ex.com/t/1194643 （macOS 实时转写+双语字幕）
- https://blog.csdn.net/Aaronfaty/article/details/162329618 （腾讯会议实时翻译，2026-06）
- https://immersivetranslate.com/blog/instant-meeting-translation/
- https://tongchuan.baidu.com/
- https://www.tranfanyi.com.cn/
- https://www.iflyrec.com/helpCenter_features_meeting/helpCenter_features_meeting.html
