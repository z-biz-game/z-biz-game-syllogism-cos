#!/usr/bin/env bash
# One-shot browser verification for 证词: real Chrome, real DOM, real canvas pixels.
#
#   bash tools/verify.sh                       # everything, offline against a local server
#   SCENARIOS="play layout" bash tools/verify.sh
#   SHOTS=run1 bash tools/verify.sh            # also drop screenshots into tools/shots/
#   BASE_URL=https://z-biz-game.github.io/repo/ bash tools/verify.sh   # post-publish check
#
# Scenario names map onto window.__ng.<name>() in tools/scenarios.js. Two of them are special:
#   real  — tools/playtest.cjs input: trusted mouse / touch / keys through Chrome's own input
#           queue, because "all three drive the same state" is exactly the claim a synthetic
#           event can be talked into passing.
#   fit   — run under Emulation.setDeviceMetricsOverride at 420x900@2, so the phone assertions
#           are a layout fact (media queries, innerWidth, the scroll box) and not a stubbed
#           window.innerWidth.
#
# Do NOT add --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader: software
# rasterisation saturates every core and, with no CDP client attached, Chrome will not exit on
# its own.
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
PORT=${CDP_PORT:-9351}; if command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then echo ":$PORT is already LISTENING — a sibling gate or an orphan Chrome holds it; attaching there reads someone else's browser. Wait for it to finish, or rerun with CDP_PORT=<a free port>." >&2; lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >&2 || true; exit 6; fi  # 一机一台：撞在同一个默认口上时不报错的是 Chrome，报错的是绿——先让路再开闸
# This harness owns its port. Sibling repos in the same farm run their own verify.sh at the
# same time on their own port, and a long-lived dev server will happily serve a *different*
# app — hence the pre-flight identity check below.
HTTP=${HTTP_PORT:-5261}
BASE=${BASE_URL:-http://127.0.0.1:$HTTP/}
CHROME=${CHROME_BIN:-}
if [ -z "$CHROME" ]; then
  for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
           "/Applications/Chromium.app/Contents/MacOS/Chromium" \
           google-chrome chromium chromium-browser; do
    if command -v "$c" >/dev/null 2>&1 || [ -x "$c" ]; then CHROME=$c; break; fi
  done
fi
[ -x "$CHROME" ] || { echo "no Chrome found; set CHROME_BIN" >&2; exit 2; }

LOG=/tmp/syllogism
SPID=0
# BASE_URL set → test that deployment and start nothing. Unset → this script owns the server.
LOCAL=1
[ -n "${BASE_URL:-}" ] && LOCAL=0
free_port() {
  python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'
}
if [ "$LOCAL" = 1 ]; then
  # Port arbitration: every sibling repo in this farm defaults to its own fixed port, and one of
  # them may already be listening on ours — with *its* index.html. Rather than test the wrong
  # bytes (and rather than abort), move to a free port. If this very app is already served here
  # — another agent's dev server for the same repo — ride along instead of starting a second one
  # that the cleanup trap would then kill out from under them.
  SERVED_FIRST=$(curl -fsS -m 2 "$BASE" 2>/dev/null || true)
  START=1
  if [ -n "$SERVED_FIRST" ]; then
    case "$SERVED_FIRST" in
      *证词*) START=0 ;;
      *)
        P=$(free_port)
        echo "port $HTTP answers with another app; using $P instead" >&2
        HTTP=$P
        BASE="http://127.0.0.1:$HTTP/"
        ;;
    esac
  fi
  if [ "$START" = 1 ]; then
    node "$HERE/server.cjs" "$HTTP" >"$LOG-server.log" 2>&1 &
    SPID=$!
    for i in $(seq 1 40); do
      curl -fsS -m 1 "$BASE" >/dev/null 2>&1 && break
      sleep 0.25
    done
  fi
fi
# Pre-flight: prove the bytes about to be tested are this app's index.html, not some other
# repo's page that happens to answer on the same port.
SERVED=$(curl -fsS -m 5 "$BASE" 2>/dev/null || true)
case "$SERVED" in *js/main.js*) ;; *) echo "nothing served at $BASE (see $LOG-server.log)" >&2; exit 2 ;; esac
printf '%s' "$SERVED" | grep -q "证词" || {
  echo "port serving a different app: no 证词 in $BASE" >&2; exit 2; }
printf '%s' "$SERVED" | grep -qi "syllogism" || {
  echo "port serving a different app: no Syllogism title in $BASE" >&2; exit 2; }

UDD=$(mktemp -d)
"$CHROME" --headless=new --remote-debugging-port=$PORT --user-data-dir=$UDD \
  --window-size=900,900 --no-first-run --no-default-browser-check about:blank >"$LOG-chrome.log" 2>&1 &
CPID=$!
cleanup() {
  [ "$SPID" != 0 ] && kill $SPID 2>/dev/null
  kill -9 $CPID 2>/dev/null
  rm -rf $UDD
}
trap cleanup EXIT
# The watchdog redirects its fds: a background subshell inherits this script's stdout, and
# inside a pipeline it would hold the write end open long after the tests finished.
( sleep ${WD_TIMEOUT:-600}; cleanup ) </dev/null >/dev/null 2>&1 & WD=$!

# A fresh --user-data-dir binds DevTools later than a warm profile: wait on the endpoint.
for i in $(seq 1 120); do
  curl -fsS -m 1 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS -m 2 "http://127.0.0.1:$PORT/json/version" >/dev/null 2>&1 || {
  echo "devtools never bound on :$PORT" >&2; exit 3; }

export CDP_PORT=$PORT
export BASE_URL=$BASE
cd "$HERE"
node tools/playtest.cjs open "$BASE" | head -8

BOOT=""
for i in $(seq 1 60); do
  BOOT=$(node tools/playtest.cjs eval "window.syllogism?window.syllogism.version:'nope'" nonav 2>/dev/null | tr -d '\n" ')
  case "$BOOT" in *nope*|"") sleep 0.5 ;; *) break ;; esac
done
echo "boot: syllogism $BOOT at $BASE"
[ "$BOOT" = "nope" ] && { echo "window.syllogism never appeared at $BASE (see $LOG-chrome.log)" >&2; exit 4; }

FAILED=0
: >"$LOG-tally.txt"
# 部署集闸：ci.yml 跑这两步、本地整闸以前一次都不跑（59 仓同形）。「本地全绿、线上 404 自己的
# manifest / sw.js / 图标」这一类坏法缺的就是这一步。它不碰 DOM，放在场景腿之前、FAILED 归零之后
# ——插在归零之前就会被那一句抹掉，那是假绿的一条现成通道。
echo "=== deploy-set ==="
node tools/deploy-set.mjs || FAILED=1
node tools/deploy-set-selftest.mjs || FAILED=1
for s in ${SCENARIOS:-engine gen play hint save resume layout input real fit}; do
  echo "=== $s ==="
  case "$s" in
    real) RUN="node tools/playtest.cjs input" ;;
    fit)  RUN="VIEWPORT=${FIT_VIEWPORT:-420x900x2} node tools/playtest.cjs scenario fit" ;;
    *)    RUN="node tools/playtest.cjs scenario $s" ;;
  esac
  eval "$RUN" 2>"$LOG-$s.console.log" | tail -1 | sed 's/^RESULT //' | SCENARIO="$s" TALLY="$LOG-tally.txt" python3 -c "
import sys, json, os
raw = sys.stdin.read().strip()
name = os.environ['SCENARIO']
tally = os.environ['TALLY']
if not raw:
    print('  NO RESULT (see /tmp/syllogism-%s.console.log)' % name)
    open(tally,'a').write('0 1 0\n'); sys.exit(1)
try:
    d = json.loads(raw)
except Exception:
    print('  UNPARSED:', raw[:300])
    open(tally,'a').write('0 1 0\n'); sys.exit(1)
for r in d['rows']:
    if not r['pass']: print('  FAIL %-48s %s' % (r['test'], r['detail'][:160]))
if not d['rows']:
    print('  NO CHECKS RUN — a scenario that asserts nothing cannot be green')
extra = {k: v for k, v in d.items() if k not in ('rows', 'fail')}
print('  %d checks, %d failed  %s' % (len(d['rows']), d['fail'], extra if extra else ''))
open(tally,'a').write('%d %d %d\n' % (len(d['rows']), d['fail'], 0 if d['rows'] else 1))
sys.exit(1 if d['fail'] or not d['rows'] else 0)
" || FAILED=1
  if [ -s "$LOG-$s.console.log" ]; then
    echo "  --- console ---"
    sed 's/^/  /' "$LOG-$s.console.log" | tail -14
  fi
done

if [ -n "${SHOTS:-}" ]; then
  mkdir -p tools/shots
  node tools/playtest.cjs eval "window.syllogism.show('menu');'ok'" nonav >/dev/null 2>&1
  sleep 0.6; node tools/playtest.cjs shot tools/shots/menu-$SHOTS.png >/dev/null
  node tools/playtest.cjs eval "window.syllogism.begin({tier:'expert',seed:'shot|board'});for(let i=0;i<5;i++)window.syllogism.useHint();window.syllogism.game.toggleNote(window.syllogism.game.board.statements[0].id);'ok'" nonav >/dev/null 2>&1
  sleep 0.8; node tools/playtest.cjs shot tools/shots/board-$SHOTS.png >/dev/null
  node tools/playtest.cjs eval "window.syllogism.begin({tier:'trainee',seed:'shot|win'});window.syllogism.solveWithLogic();'ok'" nonav >/dev/null 2>&1
  sleep 1.2; node tools/playtest.cjs shot tools/shots/win-$SHOTS.png >/dev/null
  VIEWPORT=390x844x3 node tools/playtest.cjs eval "window.syllogism.begin({tier:'master',seed:'shot|phone'});for(let i=0;i<4;i++)window.syllogism.useHint();'ok'" >/dev/null 2>&1
  sleep 0.8; VIEWPORT=390x844x3 node tools/playtest.cjs shot tools/shots/phone-$SHOTS.png >/dev/null
  echo "shots: $(ls tools/shots/*-$SHOTS.png 2>/dev/null | tr '\n' ' ')"
fi

kill $WD 2>/dev/null
T=$(awk '{c+=$1; f+=$2; e+=$3} END {printf "%d checks / %d failed / %d broken scenarios", c, f, e}' "$LOG-tally.txt")
echo "=== total: $T over ${PWD##*/} ($BASE) ==="
[ $FAILED -eq 0 ] && echo "=== ALL GREEN ===" || echo "=== FAILURES ABOVE ==="
exit $FAILED
