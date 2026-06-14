import requests, json
BASE = 'http://localhost:8765'
# Login as Tianruyu
r = requests.post(f'{BASE}/api/auth/login', json={'username': 'Tianruyu', 'password': 'admin123'})
t = r.json()['token']
h = {'Authorization': f'Bearer {t}'}
# Test group members
r = requests.get(f'{BASE}/api/group/members', headers=h)
groups = r.json()
print(f'Tianruyu sees {len(groups)} groups:')
if isinstance(groups, dict):
    for gid, g in groups.items():
        admin_name = g.get('adminName', 'unknown')
        members = g.get('members', [])
        for m in members:
            print(f'  {admin_name} -> {m.get("username")} / {m.get("system", "?")}')
elif isinstance(groups, list):
    for g in groups:
        print(f'  {g}')
