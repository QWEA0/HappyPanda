import json
import sys
import time
import urllib.request

payload = json.load(sys.stdin)
session = None
sequence = 0

def call(method, params=None, notification=False):
    global session, sequence
    sequence += 1
    body = {"jsonrpc": "2.0", "method": method}
    if params is not None:
        body["params"] = params
    if not notification:
        body["id"] = sequence
    headers = {"Authorization": "Bearer " + payload["token"],
               "Content-Type": "application/json", "Accept": "application/json, text/event-stream"}
    if session:
        headers["Mcp-Session-Id"] = session
    request = urllib.request.Request(payload["url"], data=json.dumps(body).encode(), headers=headers, method="POST")
    with urllib.request.urlopen(request, timeout=60) as response:
        session = response.headers.get("Mcp-Session-Id") or session
        raw = response.read().decode()
        return json.loads(raw) if raw else None

def tool(name, arguments):
    response = call("tools/call", {"name": name, "arguments": {"workspace_id": payload["workspaceId"], **arguments}})
    if "error" in response:
        raise RuntimeError(json.dumps(response["error"]))
    result = response["result"]
    if result.get("isError"):
        raise RuntimeError(json.dumps(result.get("structuredContent")))
    return result.get("structuredContent")

call("initialize", {"protocolVersion": "2025-03-26", "capabilities": {},
                     "clientInfo": {"name": "happypanda-remote-smoke", "version": "1"}})
call("notifications/initialized", notification=True)
read_result = tool("local_read_file", {"path": "hello.txt"})
request = {"relativecwd": ".", "command": "Write-Output HAPPYPANDA_LOCAL_EXEC", "shell": "powershell",
           "profile": "no-profile", "op_id": payload["opId"], "timeout_ms": 15000}
receipt = tool("local_exec", request)
job_id = receipt["job_id"]
for _ in range(40):
    receipt = tool("local_job_status", {"job_id": job_id})
    if receipt["status"] == "completed":
        break
    if receipt["status"] in ("failed", "timed_out", "cancelled", "unknown"):
        raise RuntimeError("Unexpected job state: " + receipt["status"])
    time.sleep(0.25)
if receipt["status"] != "completed" or receipt["exit_code"] != 0:
    raise RuntimeError("Local command did not complete successfully")
output = tool("local_job_output", {"job_id": job_id})
if "HAPPYPANDA_LOCAL_EXEC" not in json.dumps(output):
    raise RuntimeError("Local command output missing")
duplicate = tool("local_exec", request)
if duplicate["job_id"] != job_id:
    raise RuntimeError("Retry started a duplicate command")
print(json.dumps({"read": bool(read_result), "exec": True, "output": True, "idempotent": True}))
