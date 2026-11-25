#!/usr/bin/env bash
# 端到端验证：**真的启动一个 dsh**，加载本插件，让压缩门槛真的被跨过。
#
# 为什么需要这一层（2026-11-25）：
#   单元测试里引擎和 meter 都是假的，只能证明「策略解析对了」。但线上出过的事
#   故是另一类——策略没到引擎、引擎在错误的 fiber 上跑、补丁层被静默丢弃。
#   这些只有让真宿主跑起来、真的把上下文堆过门槛才看得见。
#
# 手法：假 provider 声明一个**很大的** contextWindow（200k），同时用绝对 token
# 数把门槛压到几轮对话就能超过（thresholdTokens）。这样不用真烧 token，也能在
# 十几秒内看到 `gate=wait` 翻成 `gate=FIRE`。
#
# 用法：
#   e2e/run.sh          # 全部场景
#   e2e/run.sh fired    # 单个场景
#   e2e/run.sh --list
#
# 前置：本机已装 dsh（PATH 或 DSH_BIN 指定），Node 22+。
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(dirname "$HERE")"
DSH_BIN="${DSH_BIN:-$(command -v dsh || echo "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/lib/bin.js")}"
# 默认测工作树源码；PLUGIN_SPEC='@magic6/dsh-compaction-policy-engine@0.5.8' 可测已发布版本。
PLUGIN_SPEC="${PLUGIN_SPEC:-$REPO}"

WORK="${E2E_WORK:-/tmp/dsh-compaction-e2e}"
export DSH_HOME="$WORK/home"
export FAKE_KEY=dummy
export DEEPSEEK_API_KEY=dummy
export LC_ALL=C
export DSH_COMPACT_DEBUG=1

PORT="${PORT:-8811}"
THRESHOLD_TOKENS="${THRESHOLD_TOKENS:-12000}"
RETAIN_TOKENS="${RETAIN_TOKENS:-1000}"

pass=0; fail=0; failed_names=()

section() { printf '\n\033[1m══ %s\033[0m\n' "$*"; }
ok()   { pass=$((pass+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad()  { fail=$((fail+1)); failed_names+=("$*"); printf '  \033[31m✗\033[0m %s\n' "$*"; }

prepare() {
	rm -rf "$WORK"; mkdir -p "$WORK"
	( cd "$WORK" && "$DSH_BIN" --profile headless --dump-config >/dev/null 2>&1 || true )
	local prof="$DSH_HOME/profiles/headless"
	[ -d "$prof" ] || { echo "无法创建临时 profile: $prof" >&2; exit 1; }

	( cd "$prof" && "$DSH_BIN" plugin --profile headless add "$PLUGIN_SPEC" >/dev/null 2>&1 ) \
		|| { echo "插件安装失败: $PLUGIN_SPEC" >&2; exit 1; }

	cat > "$prof/cordis.patch.yml" <<YAML
# 压缩引擎端到端场景 profile（由 e2e/run.sh 生成，每次跑都覆盖）。
#
# 窗口开到 200k、门槛压到 ${THRESHOLD_TOKENS} 个绝对 token —— 这样几轮对话就能跨过
# 门槛，又不用真的喂 12k token 进去。用比例不行：比例会跟着窗口一起放大。
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      fake:
        displayName: Fake
        apiKeyEnv: FAKE_KEY
        api: openai-completions
        baseURL: http://127.0.0.1:$PORT/v1
        models:
          - id: tiny
            name: tiny
            contextWindow: 200000
            input: [text]
- id: agent-default-model
  config:
    provider: fake
    model: tiny
# ctx.compaction 是单槽位：装了本引擎就必须关掉官方那个，否则同一步跑两个引擎，
# 门槛低的那个赢。
# ⚠ 这里**不写** '- id: compaction-control / disabled: false'（2026-11-26 移除）。
#
# 一度写着它，理由是「引擎出厂 disabled，e2e 得打开才能测」。代价是这套测试再也
# 测不出「bundle 的出厂状态到底能不能用」——而这正是线上出的事：
#
#   * bundle 出厂 'compaction-control: disabled: true'
#   * 'dsh-web-app' 把宿主平面的 'compaction-basic' 也设成 disabled
#   * 于是两个引擎都没跑，而这个 'disabled: false' 一直在替 bundle 打掩护
#
# 现在只覆盖 'config:'（门槛用绝对 token 数，为了让十几秒的对话能跨过去）。disabled
# 保持 bundle 出厂值不动 —— 插件必须靠自己就能接管，这正是被测的性质。
#
# 副作用是 fixture 依赖 bundle 主动 disable 掉 'compaction-basic'：两个引擎同时订阅
# 冒泡的 agent/pre-step 会取较低阈值，e2e 会因此看到提前触发。
- id: compaction-control
  config:
    default:
      thresholdTokens: $THRESHOLD_TOKENS
      retainTokens: $RETAIN_TOKENS
      summarizationModel: fake/tiny
- insert:
    - id: compaction-control-settings
      name: '@magic6/dsh-compaction-policy-engine'
      config:
        default:
          thresholdTokens: $THRESHOLD_TOKENS
          retainTokens: $RETAIN_TOKENS
YAML
}

start_server() {
	SCRIPT="$1" PORT="$PORT" LOG_REQUESTS=1 node "$HERE/fake-llm-server.mjs" > "$WORK/fake.log" 2>&1 &
	SERVER_PID=$!
	sleep 0.8
}
stop_server() {
	[ -n "${SERVER_PID:-}" ] && kill "$SERVER_PID" 2>/dev/null
	wait "${SERVER_PID:-}" 2>/dev/null
	SERVER_PID=""
}

# 造一个新的会话并返回 id
new_session() {
	( cd "$WORK" && "$DSH_BIN" --profile headless --json headless "开始" 2>/dev/null ) \
		| python3 -c '
import json, re, sys
for line in sys.stdin:
    m = re.search(r"(session-[0-9a-f-]{36})", line)
    if m:
        print(m.group(1))
        break
'
}

# 往会话里推一轮，输出那一轮的全部 stderr（含 [compact-debug] / [compaction] 行）
turn() {
	local sid="$1" text="$2"
	( cd "$WORK" && "$DSH_BIN" --profile headless --session-id "$sid" headless "$text" 2>&1 >/dev/null )
}

FILLER="$(python3 -c "print('填充文本。' * 1500)")"

# ── 场景 1：门槛被跨过 -> FIRED，且压缩后上下文真的变小 ──────────────────────
run_fired() {
	local name="门槛跨过 -> FIRED，且压缩后上下文确实变小"
	local problems=()

	# 主对话给长回答（否则摘要不会比被替换的内容短，引擎会正确拒绝）；
	# 摘要请求给短回答。脚本按请求顺序交替。
	start_server "ok-long,ok,ok-long,ok,ok-long,ok,ok-long,ok,ok-long,ok,ok-long,ok,ok-long,ok"
	local sid; sid="$(new_session)"
	[ -n "$sid" ] || { bad "$name"; printf '      拿不到 session id\n'; stop_server; return; }

	local saw_wait=0 saw_fire=0 fired_line="" measured_after=""
	# `engine up` 是每进程一行、无条件打到 stderr 的（引擎自己保证），所以只要我们的
	# 引擎挂上了，它在**任何**一轮的输出里都会出现。累积起来断言即可。
	local all_out="" out i
	for i in 1 2 3 4 5 6; do
		out="$(turn "$sid" "$FILLER")"
		all_out+="$out"
		grep -q 'gate=wait' <<<"$out" && saw_wait=1
		if grep -q 'gate=FIRE' <<<"$out"; then
			saw_fire=1
			fired_line="$(grep -o 'FIRED.*' <<<"$out" | head -1)"
			# 同一次运行的后续轮次要拿「压缩之后的 measured」
			continue
		fi
		if [ "$saw_fire" = "1" ] && [ -z "$measured_after" ]; then
			measured_after="$(grep -oE 'measured=[0-9]+' <<<"$out" | head -1 | cut -d= -f2)"
		fi
	done

	# ⚠ 这条断言是 2026-11-26 事故的直接产物，必须放在最前面。
	#
	# 上面所有判据（gate=wait -> gate=FIRE、thresholdTokens 相等、压缩后变小）
	# 官方 `compaction-basic` **自己也能满足**：它同样按窗口比例触发、同样把上下文
	# 压小。于是插件完全没接管时，这套 e2e 依然全绿 —— Win11 上就是这样：装完插件
	# 引擎行 `disabled: true`，官方引擎停了（dsh-web-app 停的），两边都没跑，会话
	# 一路涨到 158k 后被上游连拒四次，而本地测试一次都没红过。
	#
	# 判据只有一个不会说谎的东西：引擎自己启动时打印的那行 `engine up`，它带
	# `fiber=` 和 `source=`。没有这行 = 我们的引擎根本没挂载，后面的一切都没有意义。
	#
	# 同时必须确认官方引擎**不在**跑：两个引擎同时订阅冒泡的 `agent/pre-step` 时
	# 触发点取两者中较低的那个，表现为「装完插件后压缩异常地早」。
	grep -q 'compaction\] engine up:' <<<"${all_out:-}" \
		|| problems+=("我们的引擎从未启动（没有 engine up 行）—— 插件没有接管压缩")
	if grep -q 'compaction\] engine up:' <<<"${all_out:-}"; then
		grep -q 'engine up: fiber=.*source=' <<<"${all_out:-}" \
			|| problems+=("engine up 行里没有 fiber/source，无法判断是哪一层挂的")
	fi

	[ "$saw_wait" = "1" ] || problems+=("从没出现过 gate=wait —— 门槛跳变，测的不是压力触发")
	[ "$saw_fire" = "1" ] || problems+=("六轮都没跨过门槛，压缩没触发")
	if [ -n "$fired_line" ]; then
		grep -q "thresholdTokens=$THRESHOLD_TOKENS" <<<"$fired_line" \
			|| problems+=("FIRED 行里的 thresholdTokens 不是配置值: $fired_line")
		grep -q 'source=cordis.patch.yml' <<<"$fired_line" \
			|| problems+=("策略来源不是补丁层（说明配置没读到）: $fired_line")
	fi
	# 压缩的意义是把上下文变小；这条不成立说明压缩是空转
	if [ -n "$measured_after" ] && [ "$measured_after" -ge "$THRESHOLD_TOKENS" ]; then
		problems+=("压缩后 measured=$measured_after 仍在门槛之上（压缩没生效）")
	fi

	stop_server
	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

# ── 场景 2：策略没到引擎时必须喊出来，不能静默用 baseline ─────────────────────
run_unstated() {
	local name="目标没有策略行 -> 必须报 NO THRESHOLD，不允许静默用 baseline"
	local problems=()

	# 删掉 settings 那一行，只留引擎、不给它任何 default —— 于是这个 target 没有
	# 任何一层声明门槛。线上事故正是这种状态：面板显示 42%，实际按 80% 触发。
	local prof="$DSH_HOME/profiles/headless"
	python3 - "$prof/cordis.patch.yml" <<'PY'
import re, sys
path = sys.argv[1]
text = open(path).read()
# 去掉 compaction-control 的 config 块（这一行本身不带 disabled，见 prepare() 的注释）
text = re.sub(r"(- id: compaction-control\n)  config:\n(?:    .*\n)+", r"\1", text)
# 去掉 settings 那一整块 insert
text = re.sub(r"- insert:\n    - id: compaction-control-settings\n(?:      .*\n)+", "", text)
open(path, "w").write(text)
PY

	start_server "ok,ok,ok,ok"
	local sid; sid="$(new_session)"
	local out; out="$(turn "$sid" "hello")"
	stop_server

	grep -q 'NO THRESHOLD' <<<"$out" || problems+=("策略缺失时没有任何告警，操作者会以为配置生效了")
	grep -q 'source=' <<<"$out" || problems+=("告警没带 source，无法判断配置从哪来")

	if [ "${#problems[@]}" -eq 0 ]; then ok "$name"; else
		bad "$name"; local p; for p in "${problems[@]}"; do printf '      %s\n' "$p"; done
	fi
}

SCENARIOS=(fired unstated)

main() {
	section "准备：独立 DSH_HOME + 临时 profile + 装插件"
	prepare
	echo "  DSH_HOME=$DSH_HOME"
	echo "  插件=$PLUGIN_SPEC"
	echo "  门槛=${THRESHOLD_TOKENS} tok / 保留 ${RETAIN_TOKENS} tok"

	section "场景"
	local only="${1:-}"
	if [ -z "$only" ] || [ "$only" = fired ]; then run_fired; fi
	if [ -z "$only" ] || [ "$only" = unstated ]; then run_unstated; fi

	printf '\n\033[1m结果：%d 通过，%d 失败\033[0m\n' "$pass" "$fail"
	if [ "$fail" -gt 0 ]; then printf '失败项：\n'; printf '  - %s\n' "${failed_names[@]}"; return 1; fi
	return 0
}

case "${1:-}" in
	--list) printf '%s\n' "${SCENARIOS[@]}"; exit 0 ;;
	-h|--help) sed -n '2,22p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
	*) main "${1:-}" ;;
esac
