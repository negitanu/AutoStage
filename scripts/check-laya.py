"""Integration checks against an already-running real Laya sidecar."""
import json
import math
import urllib.error
import urllib.request


def request(path, payload=None):
    data = json.dumps(payload).encode() if payload else None
    req = urllib.request.Request("http://127.0.0.1:8001" + path, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as response:
        return json.load(response)


assert request("/health")["ready"] is True
for text, expectation in [
    ("Welcome back, Alex. Your workspace. Active projects: 3.", "The user can see their workspace."),
    ("ログインしました。小林さん、おかえりなさい。ダッシュボードにプロジェクトが表示されています。", "ユーザーがログイン済みでダッシュボードが表示されている。"),
]:
    result = request("/assert", {"text": text, "expectation": expectation})
    assert math.isfinite(result["probability"]) and 0 <= result["probability"] <= 1
    assert result["evidence"] == text
    print("PASS real Laya inference", result["routing"]["model"], result["probability"])
try:
    request("/assert", {"text": "Repeated page text. " * 500, "expectation": "There is text on the page."})
    raise AssertionError("Oversized evidence was accepted")
except urllib.error.HTTPError as error:
    assert error.code == 422
    print("PASS oversized evidence rejected without truncation")
