"""Add server-side request logging to find 401 source"""
import subprocess, time, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

# Read server.js and add request logging
with open("server.js", "r", encoding="utf-8") as f:
    server_code = f.read()

# Add request logging at the start of the request handler
old_handler = "const server = http.createServer(async (req, res) => {"
new_handler = '''const server = http.createServer(async (req, res) => {
  const _origEnd = res.end.bind(res);
  const _origWriteHead = res.writeHead.bind(res);
  let _statusCode = 200;
  res.writeHead = function(code, ...args) { _statusCode = code; return _origWriteHead(code, ...args); };
  res.end = function(...args) { console.log(`[REQ] ${req.method} ${req.url} -> ${_statusCode}`); return _origEnd(...args); };'''

server_code = server_code.replace(old_handler, new_handler)

with open("server_debug.js", "w", encoding="utf-8") as f:
    f.write(server_code)

print("Starting debug server...")
subprocess.run(["taskkill", "/f", "/im", "node.exe"], capture_output=True)
time.sleep(2)
proc = subprocess.Popen(["node", "server_debug.js"], cwd=r".", stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
time.sleep(8)

# Verify
import requests
r = requests.get("http://localhost:8765/api/health")
print(f"Health: {r.json()}")

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    # Login on index
    page.goto("http://localhost:8765/index.html")
    page.wait_for_timeout(2000)
    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(2000)

    print("Logged in, going to operations page...")

    # Navigate to operations
    page.goto("http://localhost:8765/operations.html")
    page.wait_for_timeout(4000)

    browser.close()

# Read server output
time.sleep(2)
proc.terminate()
time.sleep(1)

print("\n=== Server request log ===")
try:
    out = proc.stdout.read().decode('utf-8', errors='replace')
    # Filter for REQ lines and 401 errors
    for line in out.split('\n'):
        if '[REQ]' in line or '401' in line or 'error' in line.lower():
            print(f"  {line.strip()[:200]}")
except:
    print("Could not read server output")
