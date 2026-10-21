"""Assertions for probes/conformance.sh: reads one scenario's trace and output."""
import json
import os
import sys

name, folder = sys.argv[1], sys.argv[2]
ok = True


def check(label, cond, detail=''):
    global ok
    print(f"  {'PASS' if cond else 'FAIL'}  {name}: {label}{'' if cond or not detail else f'  ({detail})'}")
    ok = ok and bool(cond)


def read(path):
    try:
        with open(os.path.join(folder, path)) as f:
            return f.read()
    except OSError:
        return ''


err = read('err.txt')
out = read('out.txt')
check('no hook was skipped or failed to load', 'skipped' not in err and 'not loaded' not in err, err.strip()[:300])

try:
    trace = json.loads(read('trace.json'))
except ValueError:
    check('debug trace written', False, out.strip()[-300:])
    sys.exit(1)

events = trace['events']
agents = list(trace['agents'].values())


def evs(kind, **match):
    return [e for e in events if e.get('ev') == kind and all(e.get(k) == v for k, v in match.items())]


if name == 'claude':
    claude = [a for a in agents if a['kind'] == 'claude']
    check('subagent recorded', len(claude) == 1, f'{len(claude)} agents')
    if not claude:
        sys.exit(1)
    a = claude[0]
    aid = a['id']
    s1 = evs('stepStart', id=aid, index=1)
    e1 = evs('stepEnd', id=aid, index=1)
    s0 = evs('stepStart', id=aid, index=0)
    check('F1 model and effort visible (the engine\'s own, haiku)', bool(s0) and s0[0].get('model') == s0[0].get('engineModel') and 'haiku' in s0[0].get('model', '') and bool(s0[0].get('engineEffort')), s0[:1])
    check('F1 the record shows model and effort', bool(a.get('model')) and bool(a.get('effort')), (a.get('model'), a.get('effort')))
    check('F2 model override applied (usage says sonnet)', bool(e1) and e1[0].get('usageModel') == 'claude-sonnet-5-5', e1[0] if e1 else 'no step 1')
    check('F2 effort override sent', bool(s1) and s1[0].get('effort') == 'low', s1[0] if s1 else '')
    e2, s3 = evs('stepEnd', id=aid, index=2), evs('stepStart', id=aid, index=3)
    gap = (s3[0]['t'] - e2[0]['t']) / 1000 if e2 and s3 else 0
    check('pause held the agent', gap >= 2.5, f'{gap:.1f}s')
    held = [evs('stepStart', id=aid, index=i) for i in (2, 3)]
    check('override held on steps 2 and 3', all(h and h[0].get('model') == 'claude-sonnet-5-5' for h in held), [h[0].get('model') if h else None for h in held])
    s4 = evs('stepStart', id=aid, index=4)
    check('override cleared returns to the engine model', bool(s4) and s4[0].get('model') == s4[0].get('engineModel') and s4[0].get('model') != 'claude-sonnet-5-5', s4[:1])
    user = [m for m in a['thread'] if m['by'] == 'user']
    check('F3 live message delivered and read', any('BANANA' in m['text'] and m.get('state') == 'read' for m in user), [(m['text'][:20], m.get('state')) for m in user])
    answers = [m['text'] for m in a['thread'] if m['by'] == 'agent']
    check('F3 agent acted on the live message', any('BANANA' in t for t in answers), answers[:1])
    completes = evs('complete', id=aid)
    resumed = [e for e in evs('stepStart', id=aid) if completes and e['t'] > completes[0]['t']]
    check('F4 finished agent resumed under the same id, still visible', bool(resumed))
    check('F4 resumed agent answered', any('MANGO' in t for t in answers), answers[-1:])
    check('F5 spawn prompt recorded', a['thread'][0]['by'] == 'parent' and 'echo one' in a['thread'][0]['text'])
    check('history kept across resume', len(a['thread']) >= 8, f"{len(a['thread'])} entries")
    lowered = out.lower()
    check('parent relayed the user messages without distrust', ('BANANA' in out or 'MANGO' in out) and 'suspicious' not in lowered and 'injection' not in lowered, out.strip()[-200:])

if name == 'codex':
    codex = [a for a in agents if a['kind'] == 'codex' and a['name'] == 'probe-codex']
    check('codex agent recorded', len(codex) == 1, f'{len(codex)} agents')
    if not codex:
        print(out[-500:])
        sys.exit(1)
    a = codex[0]
    check('codex thread started', bool(a.get('codex', {}).get('threadId')), a.get('error'))
    check('codex model visible', bool(a.get('model')), a.get('model'))
    tools = [m['text'] for m in a['thread'] if m['by'] == 'tool']
    check('codex commands streamed', any('echo A' in t for t in tools), tools[:3])
    answers = [m['text'] for m in a['thread'] if m['by'] == 'agent']
    check('F6d mid-turn steer took effect', any('STEERED' in t for t in answers), answers)
    turns = evs('codexTurnCompleted', id=a['id'])
    check('F6d steer stayed in the same turn', bool(turns) and 'STEERED' in turns[0].get('text', ''), turns[:1])
    check('F6b follow-up after finishing continued the thread', any('PING2' in t for t in answers), answers[-1:])
    check('Claude got the Codex reply', 'STEERED' in out, out.strip()[-200:])
    user = [m for m in a['thread'] if m['by'] == 'user']
    check('both messages recorded and read', len(user) == 2 and all(m.get('state') == 'read' for m in user), [(m['text'][:15], m.get('state')) for m in user])

if name == 'recover':
    # the one the bad override hit (Claude may also retry with a second agent)
    found = [x for x in agents if x['kind'] == 'claude' and evs('stepStart', id=x['id'], index=1, model='claude-nonexistent-9-9')]
    check('subagent with the bad override recorded', len(found) == 1, f'{len(found)} agents')
    if not found:
        sys.exit(1)
    a = found[0]
    aid = a['id']
    bad = evs('stepStart', id=aid, index=1)
    check('bad override was sent', bool(bad) and bad[0].get('model') == 'claude-nonexistent-9-9')
    failed = evs('stepEnd', id=aid, index=1)
    check('the bad request failed', bool(failed) and failed[0].get('stop') is None, failed[:1])
    texts = [m['text'] for m in a['thread']]
    check('override removed and agent revived', any('Override removed' in t for t in texts), texts[-4:])
    revived = [e for e in evs('stepStart', id=aid) if failed and e['t'] > failed[0]['t']]
    check('revived agent runs on the engine model', bool(revived) and revived[0].get('model') == revived[0].get('engineModel'), revived[:1])
    check('revived agent finished', a['status'] == 'completed', a['status'])

if name == 'stop':
    a = [x for x in agents if x['kind'] == 'claude'][0]
    aid = a['id']
    stopped = evs('stopped', id=aid)
    check('stop answered request 1, as asked', bool(stopped) and stopped[0].get('index') == 1, stopped)
    check('thread says it was stopped', any('Stopped from Overseer' in m['text'] for m in a['thread']))
    later = [e for e in evs('stepStart', id=aid) if stopped and e['t'] > stopped[0]['t']]
    check('no request after the stop', not later, later[:1])
    check('agent finished cleanly', a['status'] == 'completed', a['status'])
    check('Claude carried on', 'FINISHED' in out, out.strip()[-200:])

if name == 'codexapply':
    a = [x for x in agents if x['kind'] == 'codex'][0]
    texts = [m['text'] for m in a['thread']]
    check('turn interrupted to apply settings', any('apply the new settings' in t for t in texts), texts[-5:])
    starts = evs('codexTurnStart', id=a['id'])
    check('a new turn started with effort high', any(t.get('effort') == 'high' for t in starts[1:]), starts)
    check('new effort in force', a.get('effort') == 'high', a.get('effort'))
    check('codex finished after apply', a['status'] == 'completed', a.get('error'))
    check('Claude got a reply', 'FINISHED' in out, out.strip()[-200:])

sys.exit(0 if ok else 1)
