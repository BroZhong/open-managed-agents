#!/usr/bin/env python3
"""Call an existing OMA Agent with an API key and download outputs/ files.
Python 3.10+, standard library only. See ../agent-api-key-integration.md.
"""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import time
from urllib.error import HTTPError
from urllib.parse import quote
from urllib.request import Request, urlopen
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--prompt', default='请写一份简短的 API 接入说明，实际保存到 /home/user/workspace/outputs/result.md，完成后回复文件路径。')
    parser.add_argument('--session-id', help='Resume observation without submitting another message')
    parser.add_argument('--workspace-id', help='Required with --session-id')
    parser.add_argument('--timeout', type=int, default=600, help='Polling deadline in seconds')
    parser.add_argument('--output-dir', default='./oma-results')
    args = parser.parse_args()
    if bool(args.session_id) != bool(args.workspace_id):
        parser.error('--session-id and --workspace-id must be provided together')
    if args.timeout <= 0:
        parser.error('--timeout must be positive')
    key = os.environ.get('OMA_API_KEY')
    if not key:
        parser.error('Set OMA_API_KEY in the environment')
    base = os.environ.get('OMA_API_URL', 'https://agentry.welltop.tech/api').rstrip('/')
    agent = os.environ.get('OMA_AGENT_ID', 'agent_Gm9zOmeyCQ6seu0O0XEwI')

    def request(method, path, body=None, expected=200, accept='application/json'):
        data = None if body is None else json.dumps(body).encode('utf-8')
        headers = {'x-api-key': key, 'Accept': accept}
        if data is not None:
            headers['Content-Type'] = 'application/json'
        req = Request(base + path, method=method, data=data, headers=headers)
        try:
            response = urlopen(req, timeout=30)
        except HTTPError as error:
            # Avoid printing arbitrary response bodies or credentials.
            raise RuntimeError(f'{method} {path}: HTTP {error.code}') from None
        if response.status != expected:
            status = response.status
            response.close()
            raise RuntimeError(f'{method} {path}: expected {expected}, got {status}')
        return response

    def api(method, path, body=None, expected=200):
        with request(method, path, body, expected) as response:
            return json.load(response)

    # A unique local directory avoids overwriting earlier results.
    output = Path(args.output_dir) / uuid.uuid4().hex
    output.mkdir(parents=True, exist_ok=False)
    state_path = output / 'job.json'
    if args.session_id:
        session_id, workspace_id = args.session_id, args.workspace_id
        session = api('GET', '/v1/sessions/' + quote(session_id, safe=''))
        if session['workspaceId'] != workspace_id:
            raise RuntimeError('Session does not belong to the supplied Workspace')
    else:
        workspace = api('POST', '/v1/workspaces', {'name': 'API integration example'}, 201)
        workspace_id = workspace['id']
        # Persist the Workspace even if subsequent Session creation fails.
        state_path.write_text(json.dumps({'workspaceId': workspace_id}), encoding='utf-8')
        session = api('POST', '/v1/sessions', {'agent': agent, 'workspace_id': workspace_id}, 201)
        session_id = session['id']
    state = {'agentId': session['agent']['id'], 'workspaceId': workspace_id, 'sessionId': session_id}
    state_path.write_text(json.dumps(state, indent=2), encoding='utf-8')
    print(json.dumps(state), flush=True)
    print(f'State saved to {state_path}', flush=True)
    session_path = '/v1/sessions/' + quote(session_id, safe='')
    if not args.session_id:
        accepted = api('POST', session_path + '/events', {
            'events': [{'type': 'user.message', 'data': {
                'content': [{'type': 'text', 'text': args.prompt}]
            }}]
        }, 202)
        if accepted.get('accepted') is not True:
            raise RuntimeError('Event was not accepted')
        print('Accepted; waiting for session.turn_completed...', flush=True)

    deadline = time.monotonic() + args.timeout
    cursor, completed, errors = 0, False, []
    while time.monotonic() < deadline:
        page = api('GET', f'{session_path}/events?after_seq={cursor}&limit=100')
        previous = cursor
        for event in page['data']:
            cursor = max(cursor, event['seq'])
            if event['type'] == 'session.turn_completed':
                completed = True
            if event['type'] in ('session.error', 'agent.error'):
                errors.append({'seq': event['seq'], 'type': event['type']})
        # Drain every page before deciding whether the Turn succeeded.
        if page['has_more']:
            if cursor == previous:
                raise RuntimeError('Event pagination did not advance')
            continue
        if errors:
            raise RuntimeError(f'Agent reported errors: {errors}; inspect the retained Session')
        if completed:
            break
        current = api('GET', session_path)
        if current['status'] == 'terminated':
            raise RuntimeError('Session terminated before completion')
        time.sleep(3)
    else:
        raise TimeoutError('Polling timed out; the Agent may still be running. Resume with the saved IDs; do not blindly resubmit.')

    workspace_path = '/v1/workspaces/' + quote(workspace_id, safe='')
    files = api('GET', workspace_path + '/files?prefix=outputs/')['data']
    if not files:
        raise RuntimeError('Turn completed but outputs/ is empty; inspect the Session and output requirements')
    for entry in files:
        path = entry['path']
        parts = path.split('/')
        if (PurePosixPath(path).is_absolute() or '\\' in path or
                any(part in ('', '.', '..') for part in parts) or parts[0] != 'outputs'):
            raise RuntimeError('Unsafe output file path')
        target = output.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        encoded = '/'.join(quote(part, safe='') for part in parts)
        with request('GET', workspace_path + '/files/' + encoded + '?download=1', accept='*/*') as response:
            with target.open('xb') as destination:
                shutil.copyfileobj(response, destination)
        print(f'Downloaded {path} -> {target}', flush=True)
    print('Complete. Workspace, Session and server artifacts are retained.')


if __name__ == '__main__':
    main()
