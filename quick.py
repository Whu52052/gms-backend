import requests, sys
sys.stdout.reconfigure(encoding='utf-8')
BASE = 'http://123.207.74.164:8765'
h = {'Content-Type': 'application/json'}
r = requests.post(f'{BASE}/api/auth/login', json={'username': 'Yunwei', 'password': 'yunwei1025'}, headers=h)
t = r.json()['token']
h['Authorization'] = f'Bearer {t}'
r = requests.get(f'{BASE}/api/machines', headers=h)
machines = r.json()
print(f'Total: {len(machines)}')
we = [m for m in machines if m.get('machineNumber') == 'we-001']
print(f'we-001 records: {len(we)}')
for i, m in enumerate(we):
    print(f'  [{i}] status={m.get("status")} updatedAt={m.get("updatedAt")} id={m.get("id","")[:15]}')
r = requests.get(f'{BASE}/js/config.js')
for l in r.text.split('\n'):
    if 'GMS_SERVER_URL' in l:
        print(f'Config: {l.strip()}')
