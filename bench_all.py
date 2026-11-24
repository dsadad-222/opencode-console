# -*- coding: utf-8 -*-
"""8893 全模型实测: 速度 / 能力 / 稳定性 排行"""
import json, time, statistics, concurrent.futures, urllib.request

BASE = "http://127.0.0.1:8893"
TIMEOUT = 90

def get_models():
    with urllib.request.urlopen(BASE + "/v1/models", timeout=10) as r:
        return [m["id"] for m in json.load(r)["data"]]

# 判分题库: (问题, 可接受的答案子串列表)
QUIZ = [
    ("法国的首都是哪里？只回答城市名。", ["巴黎", "paris"]),
    ("9 * 13 等于多少？只回答数字。", ["117"]),
    ("'stability' 这个单词有几个字母？只回答数字。", ["9"]),
]
PING = ("回复两个字：好的", None)

def chat(model, q, max_tokens=100):
    body = json.dumps({
        "model": model,
        "messages": [{"role": "user", "content": q}],
        "max_tokens": max_tokens,
        "stream": False,
    }).encode()
    req = urllib.request.Request(BASE + "/v1/chat/completions", data=body,
        headers={"Content-Type": "application/json"})
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            d = json.load(r)
        dt = time.time() - t0
        content = ""
        ch = d.get("choices")
        if ch:
            content = ch[0].get("message", {}).get("content") or ""
            # 兼容推理模型把内容放 reasoning
            if not content.strip():
                content = ch[0]["message"].get("reasoning_content") or ""
        return dt, content.strip()
    except Exception as e:
        return None, f"{type(e).__name__}: {str(e)[:120]}"

def test_model(mid):
    rows = []
    for i, (q, accept) in enumerate(QUIZ):
        dt, out = chat(mid, q)
        ok = False
        if dt is not None:
            low = out.lower()
            ok = any(a.lower() in low for a in accept) if accept else True
        rows.append({"round": i + 1, "lat": dt, "ok_http": dt is not None, "correct": ok, "out": out[:80] if dt else out})
        time.sleep(0.3)
    lats = [r["lat"] for r in rows if r["lat"]]
    return {
        "model": mid,
        "success": sum(r["ok_http"] for r in rows),
        "correct": sum(r["correct"] for r in rows),
        "avg_lat": round(statistics.mean(lats), 2) if lats else None,
        "min_lat": round(min(lats), 2) if lats else None,
        "max_lat": round(max(lats), 2) if lats else None,
        "detail": rows,
    }

def main():
    models = get_models()
    print(f"共 {len(models)} 个模型, 开始测试 (并发 4, 每模型 3 轮)...\n", flush=True)
    results = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as ex:
        futs = {ex.submit(test_model, m): m for m in models}
        done = 0
        for f in concurrent.futures.as_completed(futs):
            r = f.result()
            results.append(r)
            done += 1
            print(f"[{done}/{len(models)}] {r['model']}  成功{r['success']}/3 对{r['correct']}/3 均{r['avg_lat']}s", flush=True)
    with open(r"D:\opencode-console\test_results.json", "w", encoding="utf-8") as fp:
        json.dump(results, fp, ensure_ascii=False, indent=1)
    print("\n结果已写入 D:\\opencode-console\\test_results.json")

if __name__ == "__main__":
    main()
