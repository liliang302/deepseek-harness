#!/usr/bin/env bash
# 一键验证 hindsight-memory 的存储与加载链路。
# 用法：bash tests/verify.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BANK="${HS_BANK:-hermes}"
HS="${HS_URL:-http://127.0.0.1:8888}"
PROFILE="${DSH_PROFILE_DIR:-$HOME/.dsh/profiles/desktop}"
pass=0
fail=0

ok()   { echo "  PASS  $1"; pass=$((pass + 1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail + 1)); }
skip() { echo "  SKIP  $1"; }

echo "== 1. Hindsight 健康 =="
if curl -sf -m 5 "$HS/health" | grep -q '"status":"healthy"'; then
  ok "健康检查"
else
  bad "健康检查（$HS/health 不可用）"
fi

echo "== 2. 运行版本与工作区一致 =="
LINK="$PROFILE/node_modules/hindsight-memory"
if [ -L "$LINK" ] && [ "$(cd "$LINK" && pwd -P)" = "$(cd "$DIR" && pwd -P)" ]; then
  ok "bundle 链接指向工作区（${LINK}）"
elif diff -r "$DIR" "$PROFILE/hindsight-memory" >/dev/null 2>&1; then
  ok "相对路径镜像一致"
else
  bad "运行版本与工作区不一致（bundle 方式请 install_bundle；镜像方式请 rsync）"
fi

echo "== 3. 集成测试 =="
if node "$DIR/tests/integration.mjs" >/tmp/hs-verify.log 2>&1; then
  ok "tests/integration.mjs 全部通过"
else
  bad "tests/integration.mjs 失败，见 /tmp/hs-verify.log"
fi

count() {
  curl -s -m 5 "$HS/v1/default/banks/$BANK/documents?tags=dsh&tags=$1&tags_match=all_strict&limit=200" \
    | python3 -c "import json,sys;print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo 0
}

echo "== 4. curated 条目 =="
CURATED="$(count curated)"
if [ "${CURATED:-0}" -ge 1 ]; then
  ok "curated 文档 ${CURATED} 条"
else
  bad "curated 文档为 0（快照会是引导文本）"
fi

echo "== 5. session 沉淀 =="
SESSION="$(count mem:session)"
if [ "${SESSION:-0}" -ge 1 ]; then
  ok "mem:session 文档 ${SESSION} 条"
else
  skip "还没有 mem:session 文档（完成一轮实质对话后再查）"
fi

echo "== 6. 严格 tag 过滤 =="
LOOSE="$(curl -s -m 5 "$HS/v1/default/banks/$BANK/documents?tags=dsh&tags=curated&tags_match=any&limit=200" \
  | python3 -c "import json,sys;print(json.load(sys.stdin).get('total',0))" 2>/dev/null || echo 0)"
if [ "${LOOSE:-0}" -ge "${CURATED:-0}" ]; then
  ok "any=${LOOSE} ≥ all_strict=${CURATED}（符合预期：any 会放宽）"
else
  bad "tag 过滤语义异常：any=${LOOSE} < all_strict=${CURATED}"
fi

echo
echo "结果：$pass 通过，$fail 失败"
[ "$fail" -eq 0 ]
