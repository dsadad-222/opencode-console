# opencode 上游控制台

管理 `127.0.0.1:8893` 这条 opencode 免费档转发链路的本地控制台。
外观照搬 codebuddy2api 的管理台（同一套 design token），管理对象从「账号池」换成「模型池」。

- 控制台地址：**http://127.0.0.1:8895**
- 转发层：`127.0.0.1:8893`（OpenAI 兼容）
- opencode serve：`127.0.0.1:5099`
- 无登录（仅绑 127.0.0.1，与 cb2api 控制台一致）

---

## 一、目录

| 路径 | 作用 |
|---|---|
| `D:\opencode-console\server.py` | 控制台后端（纯标准库，无第三方依赖） |
| `D:\opencode-console\static\` | 前端：`index.html` / `style.css`（复制自 cb2api）/ `extra.css` / `app.js` |
| `D:\opencode-console\config.json` | **运行时配置**，由 8893 读写（黑名单/别名/默认模型/网络模式） |
| `D:\opencode-console\console.db` | SQLite：`events`（请求日志）/ `probes`（实测记录）/ `kv`（设置与游标） |
| `D:\opencode-console\logs\console.log` | 控制台自己的日志 |
| `D:\opencode-console\logs\forward.log` | 转发层日志（guardian 里配置的） |
| `C:\Users\y7000\WorkBuddy\2026-08-16-05-24-49\openrouter-test\opencode_forward.py` | 转发层源码（已加 `/admin/*` 端点） |

---

## 二、架构

```
客户端 / DSH
     │  OpenAI 兼容
     ▼
127.0.0.1:8893  opencode_forward.py  ── 内存环形缓冲 _EVENTS(3000)
     │                                      │
     │  /admin/events?since=N               │ 每 5 秒拉增量
     ▼                                      ▼
127.0.0.1:5099  opencode serve      127.0.0.1:8895  控制台
     │                                      │
     ▼                                      ▼
opencode.ai/zen                     SQLite console.db（30 天）
```

**为什么配置存在 8893 那边**：控制台只是界面 + 历史库。控制台挂了，转发层照样按上次保存的
策略跑。反过来，8893 挂了控制台会显示离线，但不会影响已有配置。

**为什么日志存在控制台这边**：8893 只留内存环形缓冲（不写盘），控制台每 5 秒拉一次落 SQLite。
这样 30 天日志不会长在转发层身上，也避免高频请求把磁盘写满。

---

## 二·五、双模式路由（2026-10-22 加，v12-proxy；v13 补 pipe 档工具模拟）

8893 现在**按模型名自动分流**，客户端只填一个 URL 就行：

```
模型名以 -free 结尾 / big-pickle  →  pipe   → serve(5099) → opencode zen   （免费，工具=模拟）
其余模型                          →  proxy  → 8787/v1     → codebuddy 号池  （真协议代理，工具=原生）
```

| | pipe 档 | proxy 档 |
|---|---|---|
| 模型示例 | `deepseek-v4.1-flash-free` | `deepseek-v4-flash` / `kimi-k3` / `glm-5.3` |
| 费用 | 免费 | 走 8787 号池额度 |
| `tools` / `tool_use` | **模拟支持**（提示词约定 + 输出解析） | **原生支持**，协议层保证 |
| 流式 `tool_use` | 支持（缓冲识别标记） | 支持（原生 json_delta） |
| `/v1/chat/completions` 的工具 | **模拟支持**（`tool_calls`，含流式分片） | 原样透传，含 `tool_calls` |
| 可靠性 | 取决于模型，实测 6/7 稳定 | 由上游保证 |

### pipe 档的工具模拟是怎么做的（v13）

**先纠正一个更早的错误结论**：不是「工具定义塞不进去」，而是
「一旦让 `tools` 真正生效，serve 就丢掉客户端标识 → zen 回 403」。

实测出来的判定规律（很反直觉）：

| 请求形态 | zen 的反应 |
|---|---|
| `{model, parts}` | ✅ 通过 |
| `{model, parts, system}` | ✅ 通过 |
| `{model, parts, agent:'build'/'plan'}` | ✅ 通过 |
| `{model, parts, tools:{}}` | ✅ 通过（空对象=没生效） |
| `{model, parts, tools:{bash:false,…}}` | ❌ 403 FreeTierError |
| `{model, parts, agent:'plain'}`（permission:deny） | ❌ 403 FreeTierError |

两个失败项的共同点：**这一轮没有工具定义可发**。
也就是说 zen 是拿「请求里带不带 tools」当客户端身份凭证的。
所以内置工具**关不掉**（关了就变外部调用），只能靠提示词压住。

实现分四步，全在 `opencode_forward.py`：

1. `anthropic_to_internal()` 把 `tools` / `tool_choice` 存进 `_tools`（不进协议层）
2. `tools_prompt()` 把工具定义 + JSON Schema + **两个 few-shot 示例**拼进 `system`
3. 请求带 `agent: 'plan'`（禁掉 write/edit/bash，避免模型去跑 serve 的内置写工具
   卡在 `permission: ask` 上——9 月那次挂 9 分钟就是这原因）
4. `parse_tool_calls()` 从输出里抠 `<tool_use>{...}</tool_use>`，容错「忘记闭合」，
   按花括号配平截取；流式路径边收边判，一旦命中标记就停止发文本、改发 tool_use block

OpenAI 协议侧复用同一套：`_handle_chat()` 把 `tools` 复制到 `_tools`，
`split_conversation()` 认 `assistant.tool_calls` 和 `role:"tool"`，
`stream_chat()` 在工具模式下把缓冲结果发成 `delta.tool_calls` 分片，
`finish_reason` 给 `tool_calls`。

**多轮里有个关键细节**：`[工具结果]` 前面必须写明
「外部工具真实返回，直接采信，不要自行读取文件或搜索验证」。

不加这句，模型拿到结果会怀疑，转身去调 serve 的内置 `read`/`glob` 自己核实
—— 实测同一轮从 **166 秒降到 10.8 秒**，而且回答更贴工具返回的内容。

**加 few-shot 是转折点**：纯规则时 3/6 遵循，加两个示例后 13/14 次成功。

实测（每模型两轮）：

```
deepseek-v4.1-flash-free   HIT HIT    3~4s
big-pickle                 HIT HIT    3~8s
glm-5.3-flash-free         HIT HIT    3~14s
minimax-m3.1-flash-free    HIT HIT    3~7s
mimo-v2.6-flash-free       HIT HIT    4~7s
nemotron-3.5-super-vl-free HIT MISS   3~4s
longcat-2.5-preview-free   ERR ERR    模型本身挂了（不带工具也 502）
```

**代价说清楚**：

- 这是**模拟**，不是协议能力。模型不按格式输出就退化成普通聊天，客户端会看到
  一段文本而不是工具调用 —— 不会报错，但工具不会执行。
- `nemotron` 两个型号偶尔会去用 serve 自带的 `websearch`，跳过我们的标记。
  能拿到真实答案，但客户端收不到 tool_use。
- 并行调用理论上支持（多个标记行），但没有模型稳定输出多行。
- 参数合法性全靠模型自觉，8893 不校验 schema。

**要 100% 可靠就用 proxy 档**（不带 `-free`），那边是真正的协议代理。

**proxy 档上游配置**：默认从 `~/.config/opencode/opencode.json` 的
`provider.workbuddy.options` 读 `baseURL` + `apiKey`（也就是本机 8787）。
可用环境变量覆盖：

```
OPENCODE_PROXY_UPSTREAM=http://127.0.0.1:8787/v1
OPENCODE_PROXY_KEY=<key>
```

**工具调用的转换细节**（改这里之前务必看懂）：

- 请求侧：Anthropic `tool_use` block → OpenAI `assistant.tool_calls`；
  `tool_result` block → 独立的 `role:"tool"` 消息（**必须排在 user 文本之前**）
- 响应侧：`tool_calls[].function.arguments` → `tool_use.input`（JSON 解析失败时塞 `_raw`）
- 流式：每个 `tool_calls[i]` 占一个 `content_block`，`arguments` 分片原样当
  `input_json_delta.partial_json` 发；文本块和工具块共用一条 index 序列
- `finish_reason: tool_calls` → `stop_reason: tool_use`

---

## 二·六、为什么免费档会「Connection error」（v14-compact）

DSH / ZCode 这类 IDE agent 接 pipe 档时，界面会出现：

```
运行失败  Connection error.
已重试模型请求 (3/5) -3s
```

**不是网络问题**。三个独立原因叠在一起：

| 原因 | 证据 | 处理 |
|---|---|---|
| **工具定义撑爆体积** | DSH 一次发 **92 个工具**，完整 schema 展开 35KB≈12k token | 按数量分档压缩（≤12 全量 / ≤40 精简 / >40 极简），92 个降到 5KB |
| **思考无节制** | 同一请求不传档位 **448s 超时**，传 `low` 只要 **17s** | 新增 `variant` 转译 + 默认 `low` + `high` 封顶 `medium` |
| **上游静默吞错** | zen 报 `more tokens than this model's maximum context length`，serve 只回空 message，我们回 200+空内容 | 改成显式 `error` 事件，客户端能看到真原因 |

### 新增的三个可调参数

```bash
OPENCODE_VARIANT_DEFAULT=low     # 客户端没传档位时的兜底（minimal|low|medium|high）
OPENCODE_VARIANT_CAP=medium      # 上限，客户端要 high 也只会给到 medium
OPENCODE_HISTORY_BUDGET=120000   # 历史字符预算，超了丢最老的部分
OPENCODE_TTFT=100                # 首字超时：100s 还没吐第一个字就主动断
OPENCODE_STALL=60                # 产出停滞：60s 没新增内容就主动断
```

### 两个超时是干嘛的（v15/v16 加）

免费层有两种**不同**的卡法，只用一个超时抓不住：

| 现象 | 抓它的参数 |
|---|---|
| 首字一直不来（模型光想不说，事件流还推 reasoning） | `TTFT`（实测 448s 那种） |
| 首字很快但中途不再出字（事件流还在推无关事件） | `STALL`（实测首字 3.2s、总耗时 317s 那种） |

两者都会**主动断开并回一个 `error` 事件**，把原因写清楚，而不是让客户端
干等到 317 秒后显示一句没头没脑的 `Connection error`。
`STALL` 触发时已产出的内容会保留（实测保住 554 字）。

之所以要断得比客户端早：IDE 客户端 60 秒就开始重试，干等只会让同一次
故障在上游被重复触发 5 遍。

**这六个值在控制台能看到**：路由页第 05 张卡片「体量与超时」，
数据来自 `/api/models` 的 `pipe` 字段（转发层 `/admin/config` 提供）。
控制台是只读展示 —— 这些是转发层启动时从环境变量读的，改完要重启 8893。

### 被截断时两端的信号（v17）

主动断开后光发 `error` 帧不够 —— 客户端还会看 `finish_reason`，
如果仍是 `stop` 就会认为回答完整。所以：

| 协议 | 截断时给 |
|---|---|
| OpenAI `/v1/chat/completions` | `finish_reason: "length"` |
| Anthropic `/v1/messages` | `stop_reason: "max_tokens"` |

档位怎么来的：Anthropic 的 `thinking.budget_tokens`、OpenAI 的 `reasoning_effort`
都会映射成 serve 的 `variant` 字段。以前完全没转，客户端选「High」等于白选。

### 顺带修的两处

- **历史合并成一条 `noReply`**：以前逐轮 POST，20 轮历史 = 20 次往返；现在一次灌完。
- **历史节流**：超过预算只保留最近的，开头补一句「更早的历史已省略」。

### 仍然治不好的

zen 免费层本身抖动极大：同一配置实测 17s / 35s / 145s / 413s 都出现过。
**IDE agent 类客户端（DSH、ZCode、Claude Code）建议直接用代理档模型名**
（`deepseek-v4-flash`、`kimi-k3`），那条链路 3 秒级稳定，工具调用也是原生协议。
pipe 档适合「轻量问答、单轮任务」。

---

## 二·七、外部 provider：厂商官方免费层（v18，2026-10-22）

除了「免费档（serve）」和「代理档（8787 号池）」，现在还有第三条路：
**第三方厂商自己的官方免费层**，标准 OpenAI 兼容端点，原生支持 tools。

```
模型名 kilo/...          → https://api.kilo.ai/api/gateway   （免密，开箱即用）
模型名 nvidia/...        → https://integrate.api.nvidia.com/v1
模型名 openrouter/...    → https://openrouter.ai/api/v1
```

| | 免费档 | 代理档 | **外部 provider** |
|---|---|---|---|
| 上游 | opencode serve | 8787 号池 | 厂商官方端点 |
| 工具调用 | 提示词模拟 | 原生 | **原生** |
| 是否合规 | 灰（走 zen 免费层） | 灰（号池） | **合规** |
| 封号风险 | 有 | 有 | **无** |
| 需要什么 | 无 | 无 | 一个 API Key |

### 配置文件

`D:\opencode-console\ext_providers.json`（转发层按 mtime 热加载，改完不用重启）：

```json
{
  "nvidia": {
    "name": "NVIDIA NIM",
    "base": "https://integrate.api.nvidia.com/v1",
    "key_env": "NVIDIA_NIM_API_KEY",
    "key": "",
    "enabled": true,
    "list_without_key": true
  },
  "openrouter": {
    "name": "OpenRouter",
    "base": "https://openrouter.ai/api/v1",
    "key_env": "OPENROUTER_API_KEY",
    "key": "",
    "enabled": true,
    "list_without_key": true,
    "filter": ":free"
  }
}
```

字段说明：

| 字段 | 作用 |
|---|---|
| `base` | OpenAI 兼容根地址（带 `/v1`） |
| `key_env` / `key` | **环境变量优先**，其次配置文件。控制台只显示有没有 Key，不回显 |
| `no_key` | 这家不需要 Key（Kilo 免密池）。不设的话没 Key 会直接报 `config_error` |
| `enabled` | 关掉后该家所有模型从 `/v1/models` 消失 |
| `list_without_key` | 没 Key 也去拉模型清单（三家的 `/models` 都是公开的）；只影响展示 |
| `filter` | 只收 id 含该子串的模型。OpenRouter 468 个模型里只有 18 个带 `:free`，不过滤会被付费模型淹没（调用只会 402） |
| `free_only` | 按上游自己标的 `isFree: true` 筛。Kilo 清单 401 个里 18 个免费，且有个别模型名不带 `:free`（如 `stealth/glyph-cluster`），光靠 `filter` 会漏 |
| `models` | 手写死清单，写了就不去拉（省一次请求） |

### 三条通道实测对比（2026-10-22）

| | 免费档（serve） | 代理档（8787） | **Kilo 免密** | NVIDIA / OpenRouter |
|---|---|---|---|---|
| 需要 Key | 否 | 否 | **否** | 是 |
| 工具调用 | 提示词模拟 | 原生 | **原生** | 原生 |
| 实测延迟 | 2~35s（抖动大） | 2~5s | **1.3~1.9s** | 未测（缺 Key） |
| 封号风险 | 有 | 有 | 无 | 无 |
| prompt 会被记录 | 上游未声明 | 否 | **是（官方声明）** | 视厂商 |

Kilo 的三条实测（`kilo/minimax/minimax-m3.1-flash:free`）：

```
OpenAI 非流式 + tools   1.9s  finish=tool_calls  {"city": "重庆"}
Anthropic 非流式 + tools 1.7s  stop=tool_use      blocks=[text, tool_use]
OpenAI 流式 + tools      1.3s  finish=tool_calls  分片=2
```

### ⚠️ Kilo 的隐私边界

Kilo 免费池在其模型卡里明确声明：**prompt 可能被上游记录并用于改进服务**，
「不适合生产或敏感数据」。别往里发代码、密钥、个人信息。

### Kilo 18 个免费模型实测（2026-10-22）

`对话可用 9/18，其中能调工具 8 个`。推荐前四个：

| 模型 | 对话 | 工具 | 备注 |
|---|---|---|---|
| `kilo/minimax/minimax-m3.1-flash:free` | 1.9s | ✓ | **首选**，快且稳，两轮循环正确 |
| `kilo/recursive/flint-v1.0:free` | 0.9s | ✓ | 最快 |
| `kilo/reflection/beam-free` | 1.1s | ✓ | |
| `kilo/nvidia/nemotron-3-ultra-550b-a55b:free` | 1.2s | ✓ | 大模型 |
| `kilo/kilo-auto/free` | 3.9s | ✓ | 自动路由，偶尔挑到慢的 |
| `kilo/dots-studio/dots-3-note-preview:free` | 1.6s | ✓ | |
| `kilo/poolside/laguna-s-2.1:free` | 2.1s | ✓ | |
| `kilo/openrouter/free` | 2.7s | ✓ | |
| `kilo/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free` | 2.1s | ✗ | 对话正常但不调工具 |

不可用的 9 个（暂时，上游随时可能恢复）：

```
空回复   stealth/glyph-cluster
         liquid/lfm-2.5-2.6b:free
         nvidia/nemotron-3.5-lightning:free
         nvidia/nemotron-3.5-content-safety:free   ← 内容审查模型，不是聊天模型
         cohere/north-mini-code:free
502      xingchen-agi/xing4.0-29b-a4b:free
         poolside/laguna-xs-2.1:free
         nvidia/nemotron-3-super-120b-a12b:free
超时     nvidia/nemotron-3.5-super-vl:free        （90s 无响应）
```

清单是动态拉的，上游上新会自动出现；要固定成只留可用的，在
`ext_providers.json` 的 `kilo` 里写 `models: ["minimax/...:free", ...]` 即可
（写了就不去拉清单）。

### 多轮工具循环实测（真实 agent 场景）

```
OpenAI 协议    轮1 1.5s tool_calls / 轮2 5.0s stop      → 正确采信工具结果
Anthropic 协议 轮1 2.1s tool_use    / 轮2 3.8s end_turn → 正确采信工具结果
```

对比免费档（serve）：同一场景第二轮曾要 **166 秒**，因为模型不信任
`[工具结果]` 会自己调 serve 的 read/glob 去核实。Kilo 是直连，没有这个毛病。

### Kilo 的速率与热加载（实测）

- **连续 12 次、间隔 0.2s：0 失败**，延迟稳定 1.3~2.9s，没触发 429。
- **改 `ext_providers.json` 立即生效**，不用重启：白名单 9 个 → 清空变 18（动态）→ 恢复变 9。
  踩过一个坑：`ext_models()` 缓存命中时压根不调 `ext_load()`，
  导致「mtime 变了就清缓存」永远不执行，改配置要等满 300 秒。
  修法是在 `ext_models()` 开头先 `ext_load()` 一下。

当前 Kilo 只暴露实测可用的 9 个（其余空回复/502 的已排除）。
想看上游新上架的模型，把 `kilo.models` 改成 `[]` 即可恢复动态清单。

### 只有「真能调」的才进 /v1/models（v20）

没配 Key 的 provider，哪怕 `/models` 能拉到清单，**也不出现在 `/v1/models` 里** ——
否则 IDE 客户端的选择器会混进几十个点了就报错的模型（NVIDIA 一家 83 个）。

两种口径分开：

| 接口 | 给什么 |
|---|---|
| `/v1/models` | 只给能调的：有 Key 或标了 `no_key` |
| `/admin/config` 的 `ext[]` | `models` = 上游总数（含缺 Key），`ready` = 当前可用数 |

控制台卡片据此显示：

```
Kilo AI 免密池    已配 Key     9 个模型
NVIDIA NIM        缺 Key       0/83 可用 · 缺 Key 不进选择器
OpenRouter        缺 Key       0/18 可用 · 缺 Key 不进选择器
```

配了 Key 之后 `ready` 立刻变成全量，`/v1/models` 里就出现了 —— 不用重启。

### 本机已有的代理端口也聚合进来了（v20）

除了外部厂商，本机原来那些代理端口一并接进来，8893 成为**唯一入口**：

| 前缀 | 上游 | 模型数 | 特点 |
|---|---|---|---|
| `vision/` | `127.0.0.1:8894` | 2 | **视觉**：`glm-4v-flash` 0.7s 实测能认颜色 |
| `codex/` | `127.0.0.1:8899` | 5 | Codex++ 池，`ling-3.0-flash-vl` 也是视觉 |
| `mimo/` | `127.0.0.1:18790` | 5 | 0.6~0.8s，最快的一档 |

三者都 `no_key: true`（本地信任），模型白名单写死。

**这是 8893 第一次真正具备视觉能力**：之前只有 opencode 免费档声明了
`attachment: true`，其余全是文本。现在：

```bash
# OpenAI 协议发图
{"model": "vision/zhipu/glm-4v-flash",
 "messages": [{"role": "user", "content": [
     {"type": "text", "text": "这张图主要是什么颜色？"},
     {"type": "image_url",
      "image_url": {"url": "data:image/png;base64,iVBOR..."}}]}]}
```

实测（发一张 64×64 纯红 PNG，问颜色）：

```
vision/zhipu/glm-4v-flash                0.7s   红色   ✓
codex/inclusionai/ling-3.0-flash-vl:free 1.4s   红色   ✓
vision/gemini/gemini-2.0-flash           → 502，已移出
vision/nvidia/nemotron-nano-2-vl         → 502，已移出
vision/THUDM/GLM-4.1V-9B-Thinking        → 502，已移出
```

**两条协议都验证过**（同一张 64×64 纯蓝 PNG，问颜色）：

```
Anthropic /v1/messages   0.9s   stop=end_turn   「蓝色」  ✓
OpenAI /v1/chat/...      0.7s   finish=stop     「蓝色」  ✓
```

Anthropic 侧用 `{"type":"image","source":{"type":"base64","media_type":"image/png","data":"..."}}`，
由 `anthropic_to_openai()` 转成 OpenAI 的 `image_url`，Claude Code 发图可直接用。

**没接的**：`5722`（Claudian Bridge）要求 API Key，返回
`{"detail":"invalid api key"}`，需要先拿到它的 Key 才能接。
`8891` 只有一个 `gemma-4-31b` 且要 12.6s，性价比太低，跳过。

现在 `/v1/models` 共 **49 个**，全部实测可用：

```
ext:kilo 9   ext:mimo 5   ext:codex 5   ext:vision 2
proxy   19   opencode 9
```

### 控制台测试台

模型页的「实测」按钮与测试台现在三条通道都能打：免费档走 serve、
代理档走 8787、外部 provider 走各自端点。下拉框按来源分组，
只放「有 Key 或免密」的 provider（NVIDIA/OpenRouter 没 Key 时不出现，免得一点就报错）。

```
deepseek-v4.1-flash-free            4.1s  在线     （免费档）
kimi-k3                             3.6s  在线     （代理档）
kilo/minimax/minimax-m3.1-flash:free 1.5s 在线     （外部 provider）
nvidia/deepseek-ai/deepseek-v4.1-flash → 明确提示缺 Key
```

### 拿 Key

- **NVIDIA NIM** — <https://build.nvidia.com/settings/api-keys>，开发者计划，免费。
  清单里就有 `deepseek-ai/deepseek-v4.1-flash`、`moonshotai/...`、`z-ai/glm-*`。
- **OpenRouter** — <https://openrouter.ai/keys>，免信用卡，约 200 请求/天。
- **Kilo** — 不用拿，直接用。

填完两种方式二选一：

```powershell
# 方式一：写进配置文件（key 字段）
notepad D:\opencode-console\ext_providers.json

# 方式二：设环境变量（对转发层进程生效，需重启一次）
setx NVIDIA_NIM_API_KEY "nvapi-xxxx"
setx OPENROUTER_API_KEY "sk-or-v1-xxxx"
```

### 没配 Key 时的行为

不会 500，也不会静默失败，而是明确告诉你缺什么：

```json
HTTP 502
{"error": {"type": "config_error",
  "message": "外部 provider「nvidia」还没配 Key（deepseek-ai/deepseek-v4.1-flash）。
              编辑 D:\\opencode-console\\ext_providers.json 填 key，
              或设置环境变量 NVIDIA_NIM_API_KEY。"}}
```

### 当前实测数量

```
/v1/models 共 147 个
  ext:kilo         18   （401 个里 isFree 的，免密可用）
  ext:nvidia       83   （NVIDIA 账号体系下的全部模型）
  ext:openrouter   18   （468 个里筛出的 :free）
  proxy            19
  opencode          9
```

**注意**：外部 provider 的模型名带斜杠，形如 `nvidia/deepseek-ai/deepseek-v4.1-flash`。
`is_pipe_model()` 会先排除带前缀的模型，所以即使名字以 `-free` 结尾也不会被误判进管道
（OpenRouter 的模型全是 `:free` 结尾）。

---

## 三、8893 新增的接口
| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/config` | 全量模型（含被拉黑的 `enabled:false`）、黑名单、config、`started_at` |
| POST | `/admin/config` | 保存配置并热应用（黑名单/别名立刻生效） |
| GET | `/admin/events?since=N` | 增量请求事件（内存环形缓冲） |
| GET | `/admin/stats` | 进程内统计（重启清零） |
| POST | `/admin/test` | `{model, prompt}` 真实打一条 |
| POST | `/admin/refresh` | 强制重拉模型列表 |

原有 `/health`、`/v1/models`、`/v1/refresh-models`、`/v1/chat/completions` 不变。
`/v1/models` 多返回一个 `name` 字段（别名），不影响兼容性。

**2026-10-21 新增 Anthropic 兼容**：

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages` | Anthropic Messages，支持流式事件序列 |
| POST | `/v1/messages/count_tokens` | token 估算（按字符数粗算） |

请求侧几乎不用转 —— `content_to_text()` 已认 `{type:'text',text:...}`，
`extract_files()` 已认 `{type:'image',source:{type:'base64',...}}`，
`split_conversation()` 本来就读顶层 `system` 字段。响应侧新写了
`anthropic_to_internal()` / `stream_messages()` / `messages_payload()`。

---

## 三·五、概览页：全通道矩阵（v21）

以前概览只统计免费档 9 个模型，代理档和外部 provider 完全是黑的。
现在三条通道合一：

```
可用模型  46/49        ← 全通道
免费档 9 · 代理 19 · 外部 21
```

矩阵按通道分成三组，每组卡片显示：provider、延迟、调用次数、是否支持工具。

| 分组 | 数据来源 | 状态判定 |
|---|---|---|
| 免费档 · serve | 主动探测 + 24h 真实调用 | 探测优先，其次真实调用 |
| 代理档 · 号池 | 只有真实调用 | 有记录 → 正常/部分失败/异常；没记录 → 未测 |
| 外部 / 本机 provider | 只有真实调用 | 同上 |

四种状态色：`正常`（绿）、`部分失败`（黄，有调用但成功率不是 100%）、
`异常`（红）、`未测`（灰）。

### 「运行全链路体检」也扩了

概览右上角那个按钮，现在除了查 8893 / serve / 上游，还会报一行
`provider：4/6 可用`（已配 Key 或免密的算可用）。

模型管理页的「全量体检」改为**全通道**（`/api/batch-test` 默认 `scope: "all"`），
一次跑完 48 个模型。实测 288 秒，46 通过：

```
longcat-2.5-preview-free               空回复（模型自身问题，75s 后空）
glm-5.1                                400 code 11133（号池上游限制）
kilo/nvidia/nemotron-3-nano-omni-...   空回复 → 已从白名单移除
```

想只测免费档（省号池额度）就传 `{"scope": "free"}`。

### 黑名单现在也管代理档（v21）

体检后发现 `glm-5.1` 无论怎么调都报：

```
HTTP 400  code 11133 / extError 1210
"the request parameters were rejected by the model provider"
```

换 prompt、去掉 `max_tokens`、加长上下文，全都一样 —— 是上游对这个模型
全面拒绝，不是我们的参数问题。这种模型留在选择器里只会让人踩坑。

现在 `config.json` 的 `blacklist` 同时作用于**免费档和代理档**：

```
代理档黑名单：隐藏 1 个（glm-5.1）
```

免费档 9 个、代理档 18 个、外部 20 个，`/v1/models` 共 47 个。

> 注意：黑名单是按**完整模型名**匹配的。`deepseek-v4-flash-free` 和
> `mimo/deepseek-v4-flash-free` 是两个不同的 id，拉黑前者不会影响后者。

## 四、六个页面

| 页面 | 干什么 |
|---|---|
| **概览** | 三层链路状态、模型健康矩阵、24h 请求曲线、最近请求、巡检异常 |
| **模型管理** | 逐个实测 / 拉黑 / 恢复 / 设默认 / 批量实测；含 24h 调用量与成功率 |
| **请求日志** | 30 天记录，按模型与结果筛选，导出 CSV |
| **路由配置** | 出网方式（auto/direct/proxy）、默认模型、巡检间隔、日志保留、黑名单 |
| **测试台** | 对单模型发真实请求，看回复与耗时，含实测历史 |
| **接入指南** | Base URL、curl 示例、DSH 配置片段 |

---

## 五、常用操作

### 拉黑一个坏模型
模型管理 → 找到该行 → 「拉黑」。等价于写进 `config.json` 的 `blacklist`，
并立即从 `/v1/models` 移除。恢复点「恢复」。

### 换默认模型
路由配置 → 默认模型 → 保存。默认模型决定「客户端传空模型名」时用哪个。

### 全量体检
模型管理 → 「全部实测」，12 个模型约 2 分钟。结果写 `probes` 表。

### 强制刷新模型列表
侧栏底部「刷新模型列表」——上游上下架随时变，列表 5 分钟缓存，这个是强刷。

### 出网方式
- `auto`（默认）：直连可用就直连，不通再试 7890 代理
- `direct`：永不设代理
- `proxy`：强制走 `127.0.0.1:7890`

> 改完只影响**下一次**拉起 serve，已跑着的 serve 不受影响。
> 历史事故：无条件设 `HTTPS_PROXY` 而 Clash 没开时，serve 的 `/global/health` 照样 healthy，
> 但所有模型返回空回复 —— 所以默认 `auto`。

---

## 六、启停

```powershell
# 启动（脱离 Job，不会随终端退出）
D:\.workbuddy\binaries\python\versions\3.13.12\python.exe D:\ai-services\_spawn_detached.py console

# 停止：按端口找 PID
D:\.workbuddy\binaries\python\versions\3.13.12\python.exe D:\ai-services\_kill_port.py 8895
```

**守护**：`D:\ai-services\guardian.ps1` 里已加 `opencode-console` 条目（名称 `opencode-console`，
端口 8895，健康检查 `/api/settings`）。guardian 本身随开机启动项 `AI-Services-Guardian.vbs` 拉起，
每 300 秒巡检一次。控制台挂了不影响 8893，所以它的恢复不着急。

---

## 七、已验证（2026-10-21）

| 项 | 结果 |
|---|---|
| 8893 v11 新端点 | `/admin/config`、`/admin/events`、`/admin/stats`、`/admin/test`、`/admin/refresh` 全部可用 |
| 非流式请求 | `deepseek-v4.1-flash-free` → 「收到」，3.1 s |
| 流式请求 | `nemotron-3-ultra-free` → 「在线」，6.6 s，`finish=stop` |
| 空模型名 | 自动走默认 `deepseek-v4.1-flash-free` |
| 事件采集 | 3 条请求 → 3 条记录，token/字符数准确 |
| 自动巡检 | 12 个在架模型 → 9 通过 / 3 异常 |
| 默认模型 | 已从 `mimo-v2.5-free`（实测空回复）改为 `deepseek-v4.1-flash-free` |
| 黑名单 | 8 个（3 个新拉黑：mimo-v2.5 / beam / space-bunny），`/v1/models` 剩 9 个 |
| `/v1/messages` 非流式 | `deepseek-v4.1` → `content:[{type:text,text:"收到"}]`，2.1 s |
| `/v1/messages` 流式 | 6 个事件，顺序 `message_start → content_block_start → delta → block_stop → message_delta → message_stop`，拼接「在线」 |
| `/v1/messages` 多轮 | 注入历史有效，正确答出「42」 |
| `/v1/messages/count_tokens` | 返回 24 |

---

## 八、踩过的坑（改代码前先看）

1. **事件批次的 epoch 必须用固定值**
   最初用 `int(time.time() - uptime)` 反推启动时间，取整会在边界漂 1 秒。
   结果同一批事件被当成新批次重采一遍，DB 里出现完全重复的记录。
   现在 8893 直接返回 `started_at: int(_T0)`。

2. **巡检请求不能混进请求统计**
   `/admin/test` 一开始也调 `record_event`，导致「成功率」和 P95 被体检流量污染
   （12 个模型里 3 个必然失败 → 成功率凭空掉 25%）。
   现在体检只写控制台的 `probes` 表。

3. **客户端中断 ≠ 上游失败**
   `curl ... | head -c 500` 会让服务端抛 `ConnectionAbortedError 10053`，
   `stream_chat` 的生成器走不到收尾，`_stats` 为空。
   现在这种记为 `err='[中断] ...'`，统计时排除在失败率之外。

4. **console 子系统程序不能用 `DETACHED_PROCESS`**
   控制台和转发层都是 `pythonw`（GUI 子系统）可以用，但 guardian 是 `powershell.exe`，
   只能 `CREATE_NO_WINDOW (0x08000000)`。

5. **`guardian.ps1` 尽量保持 ASCII**
   文件头有 BOM，PS 5.1 能正确读 UTF-8；但没有 BOM 的 UTF-8 会被按 GBK 解析成乱码。

6. **本机策略**：`schtasks.exe` 在程序黑名单；命令行里出现 `wscript` / `powershell`
   会触发 LOLBin 拦截 —— 需要时把命令塞进 `.py` 里调 `subprocess`。

---

## 九、已知限制

- **pipe 档的工具调用是模拟的**：靠提示词约定 + 输出解析（见「二·五」）。
  模型不按格式输出就退化成普通聊天，不会报错但工具不执行。
  实测 6/7 模型稳定，`nemotron` 偶尔绕过。**要可靠就用 proxy 档**。
- **pipe 档的两种协议都支持工具了**：`/v1/messages`（Anthropic）和
  `/v1/chat/completions`（OpenAI）各有一套标记缓冲与转换逻辑，
  请求侧都走同一份 `tools_prompt()`，多轮的 `tool_result` / `role:"tool"` 也都能回灌。
- **proxy 档吃 8787 号池额度**：不是免费的。高并发时 8787 那边的 `11140`
  （账号异常行为）风险仍然存在，和原来用 8787 一样。
- **`/v1/models` 的 `supports_tools` 只是标记**：客户端不看这个字段，
  它只按模型名分流。名字写错（比如把 `deepseek-v4-flash` 写成 `xxx-free`）就会掉进 pipe 档。
- **模型别名只用于展示**：`/v1/models` 的 `name` 字段和表格里的显示名，
  客户端仍要用 `id` 调用。
- **`/admin/stats` 重启清零**：跨重启的趋势看 `events` 表（概览页的 24h 数字来自 DB）。
- **巡检会消耗免费额度**：每小时一轮在架模型，每个 3~15 秒。免费档不计费，但会占请求数。
- **`/v1/messages` 的 `input_tokens` 在流式里是 0→补发**：`message_start` 时还不知道
  真实值（要等 serve 收尾），先给 0，末尾 `message_delta` 里补真实数字。
