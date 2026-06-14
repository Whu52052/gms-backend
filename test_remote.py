import requests
BASE = 'http://123.207.74.164:8765'

# Try Tianruyu
for pw in ['tianruyu', '123456', 'admin123', 'password']:
    r = requests.post(f'{BASE}/api/auth/login', json={'username': 'Tianruyu', 'password': pw})
    if r.status_code == 200 and r.json().get('token'):
        t = r.json()['token']
        h = {'Authorization': f'Bearer {t}'}
        u = r.json()['user']
        print(f'Login: {u.get("displayName")} / {u["system"]} / {u["role"]}')
        r = requests.get(f'{BASE}/api/users', headers=h)
        users = r.json()
        print(f'Sees {len(users)} users:')
        for u in users:
            print(f'  {u.get("displayName", u["username"])} / {u["system"]} / {u["role"]}')
        break
else:
    print('Cannot login as Tianruyu on remote server')
