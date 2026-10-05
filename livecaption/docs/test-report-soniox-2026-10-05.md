# 个人模式 × Soniox 真实测试报告（2026-10-05）

## 结论

| 项目 | 结果 |
| --- | --- |
| 连通 `stt-rt.soniox.com` | ✅ HTTPS / WebSocket 均可达，WebSocket 建连 0.24 s |
| Soniox Key 鉴权 | ✅ Key 有效（服务端识别出所属组织） |
| 真实识别（说话人分离 / 语种 / 延迟） | ❌ **未能测出**：Soniox 返回 `402 organization_balance_exhausted`（组织余额耗尽），没有任何转写结果 |
| `tests/e2e_personal.py`（演示 STT） | ✅ 9/9 通过 |
| `tests/e2e_livekit.py`（广播模式，演示 STT） | ✅ 通过 |
| Python 单元测试 | ✅ 57 passed（原 50 + 新增 7） |
| Web 单元测试 / 类型检查 | ✅ 8 passed，`tsc --noEmit` 通过 |
| 发现并修复的问题 | 2 个（见下文），已推送 |

**说话人分离、语种识别、延迟这三项指标目前没有数据。** 测试音频和自动统计脚本已经备好，
Soniox 账户充值后一条命令即可出结果（见「复跑」）。

## 测试环境

- LiveKit 1.9.12 + Redis 7：`docker compose up -d livekit redis`
- API（uvicorn）和 agent（`python -m livecaption_agent.worker dev`）在本机运行，Python 3.11，
  livekit-agents 1.8.4，livekit-plugins-soniox 1.8.4（模型 `stt-rt-v5`）
- `LC_STT=soniox`，`LC_TRANSLATOR=fake`，`LC_LANG_HINTS=zh,id,en`
- 网络：云端容器，出站 HTTPS 经代理
- Soniox Key 只通过启动命令的环境变量传入，没有写入任何文件或提交

## 测试音频（`tests/make_meeting_audio.py`）

用 edge-tts 生成 73.2 秒的 6 人会议，16 kHz 单声道，以会议声音（`screen_share_audio`）实时推进个人模式房间。
每段话都有标准答案（说话人、语种、起止时间），存在 `meeting.json` 里。

| # | 说话人（音色） | 语种 | 时间 (s) | 内容 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 0 | P1 云扬（男） | zh | 2.0–6.2 | 大家好，我们开始今天的周会…… | |
| 1 | P2 Ardi（男） | id | 7.4–13.1 | Baik, terima kasih. Minggu ini tim kami… | |
| 2 | P3 Jenny（女） | en | 14.3–20.6 | Great. On the marketing side… | |
| 3 | P4 晓晓（女） | zh | 21.8–26.5 | 我补充一下，客服这边上周的投诉量…… | |
| 4 | P5 Gadis（女） | id | 27.7–32.6 | Untuk logistik, pengiriman ke Surabaya… | |
| 5 | P6 Andrew（男） | en | 33.8–38.9 | I can help with that… next week, right? | |
| 6 | P5 Gadis | id | 39.1–44.1 | Ya, betul. Saya akan hubungi mereka besok pagi. | **一句话里换人**（间隔 0.15 s） |
| 7 | P1 | zh | 45.3–48.1 | 好的，那物流的问题就交给你们两位跟进。 | |
| 8 | P3 | en | 49.3–52.9 | One more thing, the budget review… | |
| 9 | P4 | zh | 53.1–56.1 | 收到，我会提前把报表发给大家。 | **一句话里换人**（间隔 0.15 s） |
| 10 | P2 | id | 57.3–59.9 | Apakah kita perlu menambah satu orang lagi… | |
| 11 | P6 Andrew | id | 61.1–65.1 | Menurut saya belum perlu… | 同一个人换了语种（英→印尼） |
| 12 | P1 | zh | 66.3–69.2 | 同意。今天就到这里，谢谢大家。 | |

## 统计方法（`tests/e2e_soniox_personal.py`）

- 每条字幕消息在房主端收到时打时间戳。按文字重合度（中文按字、其他语言按词）对齐到标准答案的哪一句。
- **说话人分离**：把「说话人 N」一对一映射到真实的人（按重合字数贪心匹配），统计：
  - 按字数计的准确率；
  - 每句话是否只归给了一个正确的人；
  - 两处无停顿换人是否被拆成两个说话人。
- **语种**：每条定稿的 `src.lang` 与标准答案比对。
- **延迟**：
  - 「说完 → 定稿字幕到达」：这句话音频结束到 final 到达房主端；
  - 「开口 → 第一行临时字幕」：这句话开始到第一条 interim 到达。

  推流按实时节奏走，计时包含 LiveKit 传输、agent 和 Soniox 全链路。

## 实测过程

1. 直接用 WebSocket 发送 4 秒音频到 `wss://stt-rt.soniox.com/transcribe-websocket`：建连成功，
   服务端返回 `error_code 402, organization_balance_exhausted`。
2. 用 agent 跑完整链路：agent 2.6 s 内入房并订阅会议声音，房主端只收到 `reset`，
   没有 interim / final。统计结果全为空。

## 发现的问题与修复

### 问题 1：设置了代理后，agent 连不上本地 LiveKit（HTTP 405）

- **现象**：机器上有 `HTTPS_PROXY` 时，agent 报 `405 Invalid response status, url=ws://localhost:7880/agent`，一直进不了房间。
- **原因**：livekit-agents 1.8.4 把 `HTTPS_PROXY` 同时用于连 LiveKit 和 job 内的 HTTP 会话（包括 STT），完全不看 `NO_PROXY`。
  国内部署常常需要代理才能访问 Soniox，而 LiveKit 在内网（`ws://livekit:7880`），所以实际部署也会碰到。
  README 原先把它列为已知限制，绕过办法是去掉代理；但那样识别服务又连不上了。
- **修复**：
  - `worker.livekit_proxy()`：`LIVEKIT_URL` 命中 `NO_PROXY` 时，LiveKit 连接不走代理；
  - 每条 STT 管道用自己的 `aiohttp.ClientSession(trust_env=True)`，按目标地址选代理，并在管道结束时关闭。
- **验证**：在本容器的代理环境下，agent 正常入房、经代理连上 Soniox；新增 4 个单元测试。

### 问题 2：识别服务欠费 / Key 无效时，agent 狂重连，用户只看到空白

- **现象**：Soniox 返回 402 时，agent 每 10 秒崩溃重连一次（80 秒内 7 次），日志刷屏。页面上没有任何提示，
  用户只会以为会议没声音。Key 无效（401/403）时也一样。
- **修复**：
  - 协议新增 `status` 消息（ARCHITECTURE.md §4）。
  - agent 遇到不可重试的 4xx 时只通知一次（402：「识别服务账户余额不足，字幕已暂停。充值后会自动恢复。」；
    401/403：「识别服务的 API Key 无效或没有权限……」），之后每 60 秒低频重试；恢复后第一个识别事件发 `ok` 清除提示。
  - 个人页、悬浮窗、主持人页显示红色横幅。
- **验证**：用真实 Soniox（402）重跑，房主端收到 1 条 `status`，内容正确，80 秒内只重试 2 次；新增 Python 3 个、Web 1 个测试。

### 其他观察（未改）

- 仓库里曾提交 `__pycache__/*.pyc`，跑测试会产生 git 改动；分支上已有提交 `0bbf2a5` 将其移出仓库。
- 测试脚本退出时 livekit rtc SDK 会打印 `FfiHandle.__del__ AssertionError`，这是 SDK 清理阶段的噪音，不影响结果。

## 复跑（充值后）

```bash
cd livecaption && docker compose up -d livekit redis
cd agent
export LIVEKIT_URL=ws://localhost:7880 LIVEKIT_API_KEY=devkey LIVEKIT_API_SECRET=secretsecretsecretsecretsecret12
LC_STT=soniox uvicorn livecaption_api.app:app --port 8000 &
LC_STT=soniox LC_TRANSLATOR=fake SONIOX_API_KEY=... python -m livecaption_agent.worker dev &
pip install edge-tts && python tests/make_meeting_audio.py /tmp/meeting
python tests/e2e_soniox_personal.py /tmp/meeting /tmp/result.json
```

脚本会打印：

- 每条定稿（说话人 / 语种 / 对应标准答案）；
- 每句话的延迟和归属；
- 汇总：`diarization_accuracy`、`utterances_speaker_ok`、`handover_split_ok`、`utterances_lang_ok`、`end_to_final_s`、`start_to_first_interim_s`。

建议的通过线（我拟定的，供参考）：

| 指标 | 通过线 |
| --- | --- |
| 说话人数 | 识别出 6 个 |
| 分离准确率 | ≥ 90 % |
| 语种 | 13/13 正确 |
| 说完 → 定稿 | 中位数 ≤ 2 s（`max_endpoint_delay_ms=1500`） |
| 开口 → 首行 | 中位数 ≤ 1 s |

无停顿换人能否拆开，取决于 Soniox 是否在一个 endpoint 里给出逐 token 的说话人（`soniox_patch.py` 已处理）。
这一项需要实测确认。
