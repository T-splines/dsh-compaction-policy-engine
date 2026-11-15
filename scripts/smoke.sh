#!/usr/bin/env bash
# 真机冒烟：压缩引擎按**部署声明的**策略起来了。
#
# 为什么需要它：引擎起不来或阈值不对时，面板照常渲染（0.2.0 的静默面 —— 插件默认值会冒充策略），
# 只有启动日志那一行能证伪。静态检查做不到这件事。
set -euo pipefail
export LC_ALL=C          # 启动日志里有非 UTF-8 字节，BSD grep 在 UTF-8 locale 下会报 Illegal byte sequence

LOG="${DSH_LOG_FILE:-${DSH_LOG:-$HOME/.dsh/logs}/dsh-web-manual.log}"
[ -f "$LOG" ] || { echo "找不到启动日志：${LOG}（可用 DSH_LOG_FILE 指定文件）"; exit 1; }

line="$(grep -a 'engine up' "$LOG" | tail -1 || true)"
[ -n "$line" ] || { echo "日志里没有 engine up —— 压缩引擎没起来：$LOG"; exit 1; }
got_thr="$(printf '%s' "$line" | grep -oE 'threshold=[0-9.]+' || true)"
got_ret="$(printf '%s' "$line" | grep -oE 'retain=[0-9.]+' || true)"

patch="${DSH_PATCH:-${DSH_HOME:-$HOME/.dsh}/profiles/${DSH_PROFILE:-web}/cordis.patch.yml}"
want_thr=""
if [ -f "$patch" ]; then
  for entry in compaction-control compaction-control-settings compaction-control-host; do
    want_thr="$(grep -A16 "id: $entry" "$patch" | grep -m1 -oE 'threshold: [0-9.]+' | grep -oE '[0-9.]+' || true)"
    [ -n "$want_thr" ] && break
  done
fi
if [ -n "$want_thr" ] && [ "$got_thr" != "threshold=$want_thr" ]; then
  echo "引擎阈值 $got_thr 与部署声明 threshold=$want_thr 不一致（${patch}）"; exit 1
fi
if [ -n "$want_thr" ]; then
  echo "engine up：$got_thr ${got_ret}（与部署声明 threshold=$want_thr 一致）"
else
  echo "engine up：$got_thr ${got_ret}（未读到部署声明：用 DSH_PATCH 指定 patch 文件后再比对）"
fi
