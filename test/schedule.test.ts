import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CheckInScheduler, type SchedulerExec } from '../src/platform/juejin/schedule.js';
import { SessionStore } from '../src/platform/juejin/session.js';

test('schedule plans validate input and preserve a stable named identity per profile', async () => {
  const scheduler = new CheckInScheduler(new SessionStore('/example/profile'), { platform: 'darwin', uid: 501 });
  const first = scheduler.plan('09:00', 'work');
  assert.equal(first.label, scheduler.plan('18:30', 'work').label);
  assert.notEqual(first.label, scheduler.plan('09:00', 'other').label);
  assert.notEqual(first.label, new CheckInScheduler(new SessionStore('/other'), { platform: 'darwin' }).plan('09:00', 'work').label);
  for (const at of ['9:00', '24:00', '09:60', '09:00\n']) assert.throws(() => scheduler.plan(at));
  for (const name of ['../bad', 'a/b', 'space name', '']) assert.throws(() => scheduler.plan('09:00', name));
  assert.throws(() => new CheckInScheduler(new SessionStore('/example'), { platform: 'freebsd' }).plan('09:00'));
});

for (const platform of ['darwin', 'linux', 'win32'] as const) {
  test(platform + ' schedule enable, update, status and disable preserve the exact profile and never run checkin immediately', async () => {
    const root = await mkdtemp(join(tmpdir(), 'juejin-scheduler-'));
    let active = false, verified = 0;
    const calls: { command: string; args: string[]; script: string }[] = [];
    const execute: SchedulerExec = async (command, args) => {
      const script = command === 'powershell.exe' ? Buffer.from(args.at(-1)!, 'base64').toString('utf16le') : '';
      calls.push({ command, args, script });
      if (command === 'launchctl' && args[0] === 'print') return { code: active ? 0 : 113, stdout: '', stderr: '' };
      if (command === 'systemctl' && args.includes('show')) return { code: 0, stdout: active ? 'LoadState=loaded\nActiveState=active' : 'LoadState=not-found\nActiveState=inactive', stderr: '' };
      if (script.includes('Get-ScheduledTask |')) return { code: 0, stdout: JSON.stringify({ enabled: active, registered: active }), stderr: '' };
      if (args[0] === 'bootstrap' || args.includes('enable') || script.includes('Register-ScheduledTask ')) active = true;
      if (args[0] === 'bootout' || args.includes('disable') || script.includes('Unregister-ScheduledTask ')) active = false;
      return { code: 0, stdout: '', stderr: '' };
    };
    const session = new SessionStore(join(root, 'profile with spaces'));
    const scheduler = new CheckInScheduler(session, {
      platform, userHome: root, uid: 501, exec: execute,
      node: join(root, 'node with spaces'), entry: join(root, 'cli & special', 'dist', 'cli.js'),
      verify: async () => { verified++; },
    });
    try {
      const preview = await scheduler.enable('10:15', { name: 'work', dryRun: true });
      assert.equal(preview.dry_run, true); assert.equal(calls.length, 0); assert.equal(verified, 0);
      const plan = scheduler.plan('10:15', 'work');
      await scheduler.enable('10:15', { name: 'work' });
      assert.equal((await scheduler.status('work')).enabled, true);
      const runner = await readFile(plan.runner, 'utf8');
      assert.ok(runner.includes(JSON.stringify(session.home)));
      assert.ok(runner.includes('"checkin","run","--json"'));
      assert.equal(runner.includes('lottery'), false);
      assert.equal(runner.includes('sessionid'), false);
      if (platform === 'darwin') {
        const definition = await readFile(join(root, 'Library', 'LaunchAgents', plan.label + '.plist'), 'utf8');
        assert.ok(definition.includes('<integer>10</integer>'));
        assert.ok(definition.includes('<integer>15</integer>'));
        assert.ok(definition.includes('<key>RunAtLoad</key><false/>'));
      } else if (platform === 'linux') {
        const timer = await readFile(join(root, '.config', 'systemd', 'user', plan.label + '.timer'), 'utf8');
        assert.ok(timer.includes('OnCalendar=*-*-* 10:15:00'));
        assert.ok(timer.includes('Persistent=true'));
      } else {
        const script = calls.find(call => call.script.includes('Register-ScheduledTask '))!.script;
        assert.ok(script.includes('-LogonType Interactive -RunLevel Limited'));
        assert.ok(script.includes('-MultipleInstances IgnoreNew'));
      }
      const label = plan.label;
      await scheduler.enable('11:30', { name: 'work' });
      assert.equal((await scheduler.status('work')).settings?.label, label);
      assert.equal((await scheduler.status('work')).settings?.at, '11:30');
      assert.equal(verified, 2);
      await scheduler.disable('work');
      assert.equal((await scheduler.status('work')).enabled, false);
      await assert.rejects(access(plan.runner), { code: 'ENOENT' });
      await scheduler.disable('work'); // Missing tasks can be disabled again without deleting another profile.
      assert.equal(active, false);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}

test('native scheduler failures are reported and do not publish a successful local configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'juejin-scheduler-'));
  const session = new SessionStore(join(root, 'profile'));
  const scheduler = new CheckInScheduler(session, {
    platform: 'darwin', userHome: root, uid: 501, verify: async () => {},
    exec: async (_command, args) => ({ code: args[0] === 'print' ? 113 : 5, stdout: '', stderr: 'fabricated failure' }),
  });
  try {
    await assert.rejects(scheduler.enable('09:00'), /系统定时任务操作失败/);
    await assert.rejects(access(join(session.home, 'schedules', 'daily.json')), { code: 'ENOENT' });
    await assert.rejects(access(join(session.home, 'write.lock')), { code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
