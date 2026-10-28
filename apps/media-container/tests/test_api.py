from __future__ import annotations

import dataclasses
import time

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient

from app.api import create_app


@pytest.fixture
def api(settings, serve):
    events: list[dict] = []
    worker = FastAPI()

    @worker.post("/internal/jobs/{job_id}/events")
    async def event(job_id: str, request: Request):
        events.append(await request.json())
        return {"ok": True}

    with serve(worker) as w:
        s = dataclasses.replace(settings, api_key="s3cret-key")
        with TestClient(create_app(s)) as client:
            yield client, events, w.url


AUTH = {"Authorization": "Bearer s3cret-key"}


def start_body(url: str, callback_base: str, job_id: str = "job_apitest01") -> dict:
    return {
        "jobId": job_id, "url": url, "chatId": 1, "selection": {"kind": "video", "container": "mp4", "videoFormatId": "x"},
        "callback": {"baseUrl": callback_base, "token": "tok"},
    }


def test_health_is_open_but_everything_else_needs_the_key(api):
    client, _, _ = api
    assert client.get("/health").json() == {"ok": True}
    for method, path in (("get", "/diagnostics"), ("post", "/inspect"), ("post", "/jobs"), ("get", "/jobs/job_abcdefgh"),
                         ("post", "/jobs/job_abcdefgh/cancel"), ("delete", "/jobs/job_abcdefgh"), ("post", "/frames")):
        resp = getattr(client, method)(path, **({"json": {}} if method == "post" else {}))
        assert resp.status_code == 401, (method, path, resp.status_code)
    assert client.get("/diagnostics", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_diagnostics_reports_tooling_without_leaking_secrets(api):
    client, _, _ = api
    body = client.get("/diagnostics", headers=AUTH).json()
    assert body["ok"] and body["ytdlp"] and "diskFreeBytes" in body and "policyProxy" in body
    assert body["localBotApi"]["enabled"] is False
    assert "s3cret-key" not in str(body) and "TEST-TOKEN" not in str(body)


def test_inspect_rejects_internal_urls(api):
    client, _, _ = api
    for url in ("http://127.0.0.1/x", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "http://localhost:8080/"):
        data = client.post("/inspect", json={"url": url}, headers=AUTH).json()
        assert data["ok"] is False and data["error"]["code"] in ("blocked_url", "invalid_url"), (url, data)
        assert data["error"]["retryable"] is False


def test_start_validates_the_request(api):
    client, _, base = api
    assert client.post("/jobs", json={"jobId": "../../x"}, headers=AUTH).status_code == 422
    bad = start_body("https://example.com/v", base, job_id="has space here")
    assert client.post("/jobs", json=bad, headers=AUTH).status_code == 422


def test_job_start_is_idempotent_and_unknown_jobs_are_reported(api):
    client, events, base = api
    assert client.get("/jobs/job_neverexist", headers=AUTH).json()["state"] == "unknown"  # => Worker treats as container_lost
    body = start_body("http://127.0.0.1/blocked.mp4", base)  # fails fast in the precheck (private target)
    first = client.post("/jobs", json=body, headers=AUTH)
    second = client.post("/jobs", json=body, headers=AUTH)
    assert first.status_code == second.status_code == 202
    deadline = time.time() + 15
    while time.time() < deadline and client.get("/jobs/job_apitest01", headers=AUTH).json()["state"] == "running":
        time.sleep(0.2)
    status = client.get("/jobs/job_apitest01", headers=AUTH).json()
    assert status["state"] == "failed" and status["errorCode"] == "blocked_url"
    failed = [e for e in events if e["type"] == "failed"]
    assert len(failed) == 1 and failed[0]["errorCode"] == "blocked_url" and failed[0]["retryable"] is False  # no duplicates
    assert client.post("/jobs", json=body, headers=AUTH).status_code == 202  # still idempotent after finishing
    assert len([e for e in events if e["type"] == "failed"]) == 1
    assert client.post("/jobs/job_apitest01/cancel", headers=AUTH).json() == {"cancelled": True}
    assert client.post("/jobs/job_unknown000/cancel", headers=AUTH).json() == {"cancelled": False}
    assert client.delete("/jobs/job_apitest01", headers=AUTH).json() == {"deleted": True}
    assert client.get("/jobs/job_apitest01", headers=AUTH).json()["state"] == "unknown"
