"""Deep debug: check localStorage through navigation"""
import subprocess, time, sys
from playwright.sync_api import sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

subprocess.run(["taskkill", "/f", "/im", "node.exe"], capture_output=True)
time.sleep(2)
proc = subprocess.Popen(["node", "server.js"], cwd=r"D:\HuaweiMoveData\Users\24492\Desktop\Shout", stdout=subprocess.PIPE, stderr=subprocess.PIPE)
time.sleep(8)

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    logs = []
    page.on("console", lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
    page.on("pageerror", lambda err: logs.append(f"[ERR] {err}"))

    # Login on index
    page.goto("http://localhost:8765/index.html")
    page.wait_for_timeout(2000)
    page.fill("#login-username", "yunying")
    page.fill("#login-password", "yunying1025")
    page.click("#login-btn")
    page.wait_for_timeout(3000)

    # Check localStorage BEFORE navigation
    ls = page.evaluate("() => ({token: localStorage.getItem('gms_token')?.substring(0,20), user: localStorage.getItem('gms_user')?.substring(0,50)})")
    print(f"Before nav: {ls}")

    # Now manually set a test value
    page.evaluate("() => localStorage.setItem('_test_nav', 'survives_navigation')")

    # Navigate to operations
    page.goto("http://localhost:8765/operations.html")
    page.wait_for_timeout(3000)

    # Check localStorage AFTER navigation
    ls2 = page.evaluate("() => ({test: localStorage.getItem('_test_nav'), token: localStorage.getItem('gms_token')?.substring(0,20), user: localStorage.getItem('gms_user')?.substring(0,50)})")
    print(f"After nav: {ls2}")

    # Check API state
    state = page.evaluate("() => ({online: API.online, token: !!API.token, cu: !!API.currentUser, initDone: true})")
    print(f"API state: {state}")

    print(f"\n=== Key logs ({len(logs)}) ===")
    for l in logs:
        if any(k in l for k in ['error', '401', 'validat', 'logout', 'check', 'init']):
            print(f"  {l[:250]}")

    browser.close()
proc.terminate()
