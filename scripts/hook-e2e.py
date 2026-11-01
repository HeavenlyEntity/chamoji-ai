#!/usr/bin/env python3
"""End-to-end check of chamoji's prepare-commit-msg hook with real git.

Builds a throwaway repo, installs the hook (directly, or through husky or
lefthook), then runs `git commit` from the given shell:

- in a pseudo-terminal, typing into the composer, and checks the commit got
  the composed message (Linux and macOS only: Windows has no pty)
- with -m, and checks the message was left alone
- with no terminal at all, and checks the commit still goes through
- after `chamoji ws start`, with -m, and checks the commit got the Workstream trailer

  python3 scripts/hook-e2e.py --shell bash|zsh|fish|pwsh [--manager husky|lefthook] [--no-tty]

Run it after `pnpm build`. Exits non-zero, saying which check failed.
"""

import argparse
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLI = os.path.join(ROOT, 'packages', 'cli', 'dist', 'cli.js')
WINDOWS = sys.platform == 'win32'
# The composer's steps: the prompt to wait for, then what to type at it.
STEPS = [
    ('Gitmoji', ['sparkles', '\r']),
    ('Scope', ['\r']),
    ('Title', ['add the report', '\r']),
    ('Body', ['\r']),
    ('Why?', ['the team asked for it', '\r']),
    ('Breaking change?', ['\r']),
]
# How long one prompt, or git finishing, may take: a slow runner needs far less.
WAIT_SECONDS = 90
EXPECTED = '✨ Add the report\n\nWhy: the team asked for it'


def fail(message):
    print(f'hook-e2e: FAIL: {message}', file=sys.stderr)
    sys.exit(1)


def shell_command(shell, command):
    if shell == 'pwsh':
        return ['pwsh', '-NoProfile', '-NonInteractive', '-Command', command]
    return [shell, '-c', command]


def environment(bindir):
    env = {k: v for k, v in os.environ.items() if k != 'CI'}
    env['PATH'] = bindir + os.pathsep + env['PATH']
    env['GIT_EDITOR'] = 'true' if not WINDOWS else 'cd .'
    env['CHAMOJI_NO_UPDATE_CHECK'] = '1'
    return env


def git(repo, *args, env=None):
    return subprocess.run(['git', *args], cwd=repo, env=env, check=True, capture_output=True, text=True).stdout


def last_message(repo):
    return git(repo, 'log', '-1', '--format=%B').strip()


def make_shim(bindir):
    os.makedirs(bindir, exist_ok=True)
    if WINDOWS:
        with open(os.path.join(bindir, 'chamoji.cmd'), 'w') as f:
            f.write(f'@node "{CLI}" %*\n')
    path = os.path.join(bindir, 'chamoji')
    with open(path, 'w') as f:
        f.write(f'#!/bin/sh\nexec node "{CLI}" "$@"\n')
    os.chmod(path, 0o755)


def make_repo(base, manager, env):
    repo = os.path.join(base, 'repo')
    os.makedirs(repo)
    git(repo, 'init', '-q', '-b', 'main')
    git(repo, 'config', 'user.name', 'Hook Test')
    git(repo, 'config', 'user.email', 'hook@example.com')
    git(repo, 'config', 'commit.gpgsign', 'false')
    git(repo, 'commit', '-q', '--allow-empty', '-m', '🎉 Init')
    npx = 'npx.cmd' if WINDOWS else 'npx'
    if manager == 'husky':
        with open(os.path.join(repo, 'package.json'), 'w') as f:
            f.write('{"name": "hook-e2e", "private": true}\n')
        subprocess.run([npx, '--yes', 'husky@9', 'init'], cwd=repo, env=env, check=True)
        with open(os.path.join(repo, '.husky', 'pre-commit'), 'w') as f:
            f.write('')
        result = subprocess.run(['chamoji', 'hook', 'install'], cwd=repo, env=env, capture_output=True, text=True, shell=WINDOWS)
        if 'chamoji hook run "$@"' not in result.stdout:
            fail(f'husky: install should print the line to add, got: {result.stdout}{result.stderr}')
        with open(os.path.join(repo, '.husky', 'prepare-commit-msg'), 'w') as f:
            f.write('chamoji hook run "$@"\n')
    elif manager == 'lefthook':
        # Installed into the project, as lefthook's hooks look for it there.
        with open(os.path.join(repo, 'package.json'), 'w') as f:
            f.write('{"name": "hook-e2e", "private": true}\n')
        with open(os.path.join(repo, '.gitignore'), 'w') as f:
            f.write('node_modules\n')
        npm = 'npm.cmd' if WINDOWS else 'npm'
        subprocess.run([npm, 'install', '--silent', '--no-audit', '--no-fund', 'lefthook@1'], cwd=repo, env=env, check=True)
        with open(os.path.join(repo, 'lefthook.yml'), 'w') as f:
            f.write('prepare-commit-msg:\n  commands:\n    chamoji:\n      run: chamoji hook run {1} {2} {3}\n      interactive: true\n')
        subprocess.run([npx, 'lefthook', 'install'], cwd=repo, env=env, check=True)
    else:
        subprocess.run(['chamoji', 'hook', 'install'], cwd=repo, env=env, check=True, shell=WINDOWS)
    return repo


def commit_in_pty(repo, shell, env):
    import pty
    import select

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(repo)
        command = shell_command(shell, 'git commit')
        os.execvpe(command[0], command, env)

    output = b''

    def read(seconds):
        nonlocal output
        ready, _, _ = select.select([fd], [], [], seconds)
        if ready:
            try:
                output += os.read(fd, 65536)
            except OSError:
                return False
        return True

    def screen():
        return re.sub(r'\x1b\[[0-9;?]*[A-Za-z]', '', output.decode('utf8', 'replace'))

    def give_up(waiting_for):
        tail = screen()[-500:]
        os.killpg(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
        fail(f'{shell}: waited {WAIT_SECONDS}s for {waiting_for}; the screen ended with:\n{tail}')

    # Typing before a prompt is up loses the keys and leaves the composer waiting, so watch the
    # screen: how long pwsh, git and node take to start varies a lot between runs.
    for prompt, keys in STEPS:
        deadline = time.time() + WAIT_SECONDS
        while prompt not in screen():
            if time.time() > deadline or not read(0.05):
                give_up(f'the {prompt!r} prompt')
        output = b''
        for key in keys:
            os.write(fd, key.encode())
            # Keys that land in one read count as pasted text, so Enter needs a gap.
            pause = time.time() + 0.3
            while time.time() < pause and read(0.05):
                pass

    deadline = time.time() + WAIT_SECONDS
    while True:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            return os.waitstatus_to_exitcode(status)
        if time.time() > deadline:
            give_up('git commit to finish')
        read(0.05)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--shell', required=True, choices=['bash', 'zsh', 'fish', 'pwsh'])
    parser.add_argument('--manager', choices=['husky', 'lefthook'])
    parser.add_argument('--no-tty', action='store_true', help='skip the interactive check (Windows)')
    args = parser.parse_args()
    if not os.path.exists(CLI):
        fail('build first: pnpm build')
    if not shutil.which('pwsh' if args.shell == 'pwsh' else args.shell):
        fail(f'{args.shell} is not installed')

    base = tempfile.mkdtemp(prefix='chamoji-hook-e2e-')
    bindir = os.path.join(base, 'bin')
    make_shim(bindir)
    env = environment(bindir)
    repo = make_repo(base, args.manager, env)
    label = f'{args.shell}{" + " + args.manager if args.manager else ""}'

    if not args.no_tty and not WINDOWS:
        with open(os.path.join(repo, 'report.txt'), 'w') as f:
            f.write('report\n')
        git(repo, 'add', 'report.txt')
        code = commit_in_pty(repo, args.shell, env)
        if code != 0:
            fail(f'{label}: git commit in a terminal exited {code}')
        if last_message(repo) != EXPECTED:
            fail(f'{label}: expected the composed message, got: {last_message(repo)!r}')
        print(f'ok   {label}: git commit in a terminal used the composer')

    with open(os.path.join(repo, 'report.txt'), 'w') as f:
        f.write('report, again\n')
    git(repo, 'add', 'report.txt')
    # Timeouts: a composer that opened where it shouldn't would wait forever.
    subprocess.run(shell_command(args.shell, 'git commit -m "plain message"'), cwd=repo, env=env, check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    if last_message(repo) != 'plain message':
        fail(f'{label}: git commit -m changed the message to {last_message(repo)!r}')
    print(f'ok   {label}: git commit -m was left alone')

    with open(os.path.join(repo, 'report.txt'), 'w') as f:
        f.write('report, from an editor\n')
    git(repo, 'add', 'report.txt')
    no_tty_env = dict(env, GIT_EDITOR='true' if not WINDOWS else 'cd .')
    result = subprocess.run(shell_command(args.shell, 'git commit -F report.txt'), cwd=repo, env=no_tty_env, stdin=subprocess.DEVNULL, capture_output=True, text=True, start_new_session=not WINDOWS, timeout=120)
    if result.returncode != 0 or last_message(repo) != 'report, from an editor':
        fail(f'{label}: a commit without a terminal failed: {result.stdout}{result.stderr}')
    print(f'ok   {label}: a commit without a terminal went through')

    # `ws start` makes the workstream active and stages .chamoji/workstreams.yml, so the
    # commit below records the file too. Like the check above, nothing here may wait on a prompt.
    started = subprocess.run(['chamoji', 'ws', 'start', 'Auth revamp'], cwd=repo, env=env, stdin=subprocess.DEVNULL, capture_output=True, text=True, shell=WINDOWS, timeout=120)
    if started.returncode != 0:
        fail(f'{label}: chamoji ws start exited {started.returncode}: {started.stdout}{started.stderr}')
    with open(os.path.join(repo, 'report.txt'), 'w') as f:
        f.write('report, in a workstream\n')
    git(repo, 'add', 'report.txt')
    subprocess.run(shell_command(args.shell, 'git commit -m "add the login"'), cwd=repo, env=env, check=True, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    if last_message(repo) != 'add the login\n\nWorkstream: auth-revamp':
        fail(f'{label}: git commit -m with an active workstream gave {last_message(repo)!r}')
    if '.chamoji/workstreams.yml' not in git(repo, 'show', '--name-only', '--format=', 'HEAD').split():
        fail(f'{label}: the commit should have recorded .chamoji/workstreams.yml')
    print(f'ok   {label}: git commit -m was stamped with the active workstream')


if __name__ == '__main__':
    main()
