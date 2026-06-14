import requests

BASE = 'http://localhost:8765'

# Login as yunying (superadmin)
r = requests.post(f'{BASE}/api/auth/login', json={'username': 'yunying', 'password': 'yunying1025'})
t = r.json()['token']
h = lambda token: {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

# Check users - find Tianruyu's ID
r = requests.get(f'{BASE}/api/users', headers=h(t))
users = r.json()
tianruyu = next((u for u in users if u['username'] == 'Tianruyu'), None)
print(f'Tianruyu: {tianruyu}')

# Find a user under Tianruyu
r = requests.get(f'{BASE}/api/group/members', headers=h(t))
groups = r.json()
print(f'\nAll groups ({len(groups)}):')
for g in (groups if isinstance(groups, list) else groups.values()):
    admin = g.get('adminName', '?')
    admin_id = g.get('adminId', '?')
    members = g.get('members', [])
    print(f'  Admin: {admin} (id={admin_id})')
    for m in members:
        print(f'    {m.get("username")} / parentId={m.get("parentId")} / system={m.get("system")}')

# Pick a user to transfer
if tianruyu and groups:
    # Find Tianruyu's group
    my_group = next((g for g in (groups if isinstance(groups, list) else groups.values())
                     if g.get('adminId') == tianruyu['id']), None)
    if my_group and my_group.get('members'):
        user_to_move = my_group['members'][0]
        print(f'\nTrying to transfer: {user_to_move["username"]}')

        # Find another admin to transfer to
        other_admin = next((u for u in users if u['role'] == 'admin' and u['id'] != tianruyu['id']), None)
        if other_admin:
            print(f'Target admin: {other_admin["username"]} (id={other_admin["id"]})')

            # Create transfer
            body = {
                'toAdminId': other_admin['id'],
                'userId': user_to_move['id'],
                'username': user_to_move['username'],
                'direction': 'out',
                'reason': 'test'
            }
            r = requests.post(f'{BASE}/api/group/transfer', headers=h(t), json=body)
            transfer = r.json()
            print(f'Create: {transfer}')

            transfer_id = transfer.get('item', {}).get('id')
            if transfer_id:
                # Approve
                r = requests.post(f'{BASE}/api/group/transfer/{transfer_id}/approve', headers=h(t))
                print(f'Approve: {r.json()}')

                # Check parentId
                r = requests.get(f'{BASE}/api/users', headers=h(t))
                for u in r.json():
                    if u['id'] == user_to_move['id']:
                        print(f'User {u["username"]} parentId after: {u.get("parentId")}')
                        break

                # Check groups after
                r = requests.get(f'{BASE}/api/group/members', headers=h(t))
                groups2 = r.json()
                print(f'\nAfter transfer - groups:')
                for g in (groups2 if isinstance(groups2, list) else groups2.values()):
                    admin = g.get('adminName', '?')
                    for m in g.get('members', []):
                        print(f'  {admin}: {m.get("username")} (parentId={m.get("parentId")})')
