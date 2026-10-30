import blessed from 'blessed';
import { DesktopObserver } from './observer';
import { age, clean, needsAttention, type Agent } from './model';
import { ReadState } from './read-state';

export function dashboard(observer: DesktopObserver, screenOptions: blessed.Widgets.IScreenOptions = {}, read = new ReadState()) {
  const screen = blessed.screen({ smartCSR: true, title: 'Codex Monitor', fullUnicode: true, ...screenOptions });
  const background = '#101522';
  const header = blessed.box({ parent: screen, top: 0, left: 1, height: 4, width: '100%-2', tags: true, style: { fg: '#e1e9ff', bg: background } });
  const list = blessed.list({ parent: screen, top: 4, bottom: 8, left: 0, right: 0,
    label: ' Sessions ', border: 'line', tags: true, keys: true, vi: true, mouse: true,
    scrollable: true, scrollbar: { ch: '│' },
    style: { fg: '#d5dff5', bg: background, border: { fg: '#536b9b' }, selected: { bg: '#244d86', fg: '#ffffff', bold: true } },
  });
  const detail = blessed.box({ parent: screen, bottom: 2, height: 6, left: 0, right: 0, border: 'line',
    label: ' Selected session ', tags: false, style: { fg: '#e1e9ff', bg: background, border: { fg: '#536b9b' } } });
  const footer = blessed.box({ parent: screen, bottom: 0, height: 2, left: 1, right: 1, style: { fg: '#9fb6d9', bg: background } });
  let filter: 'all' | 'attention' | 'working' | 'read' = 'all';
  let query = '';
  let rows: Agent[] = [];
  let selectedId: string | undefined;
  let notice = '';
  let rendering = false;
  let closed = false;
  let searching = false;

  const urgent = (agent: Agent) => needsAttention(agent) && !read.isRead(agent);
  const priority = (agent: Agent) => urgent(agent) ? 0 : agent.runtime === 'WORKING' ? 1 : read.isRead(agent) ? 3 : agent.runtime === 'UNKNOWN' ? 4 : 2;
  const fit = (text: string, width: number) => {
    const chars = [...clean(text)];
    return (chars.length > width ? chars.slice(0, Math.max(0, width - 1)).join('') + '…' : chars.join('')).padEnd(width);
  };
  const fitPath = (path: string, width: number) => {
    const text = clean(path).replace(/^\/Users\/[^/]+\//, '~/');
    const chars = [...text];
    return fit(chars.length > width ? '…' + chars.slice(-(width - 1)).join('') : text, width);
  };
  const renderDetail = () => {
    const agent = rows[(list as blessed.Widgets.ListElement & { selected: number }).selected];
    if (!agent) detail.setContent('No sessions match this view. Press a for all sessions.');
    else {
      selectedId = agent.id;
      detail.setContent([
        `${clean(agent.title)}  [${agent.runtime}${read.isRead(agent) ? ' · READ locally' : ''}]`,
        `Directory: ${clean(agent.directory || 'Unavailable')}`,
        `${clean(agent.detail)} · ${agent.evidence === 'live' ? 'Live desktop state' : 'State unavailable'}`,
        `Activity: ${new Date(agent.activityAt || agent.updatedAt).toLocaleString()}${agent.activityAt ? ' (turn / observed state change)' : ' (catalog updated)'} · ${agent.externalId}`,
      ].join('\n'));
    }
  };
  const render = () => {
    if (closed) return;
    rendering = true;
    const all = observer.agents;
    rows = all.filter(a => !a.archived).filter(a =>
      filter === 'attention' ? urgent(a) : filter === 'working' ? a.runtime === 'WORKING' : filter === 'read' ? read.isRead(a) : true,
    ).filter(a => `${a.title} ${a.directory || ''} ${a.externalId}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => priority(a) - priority(b) || (b.activityAt || b.updatedAt) - (a.activityAt || a.updatedAt) || a.id.localeCompare(b.id));
    const width = Math.max(30, Number(screen.width) - 5);
    const pathWidth = Math.max(8, Math.floor((width - 28) * .4));
    const titleWidth = Math.max(8, width - pathWidth - 28);
    list.setItems(rows.map(a => {
      const acknowledged = read.isRead(a);
      const color = urgent(a) ? '#ffd47c' : a.runtime === 'WORKING' ? '#7ab8ff' : '#a9b8cf';
      const flag = acknowledged ? 'r' : urgent(a) ? '!' : a.runtime === 'WORKING' ? '▶' : '·';
      const directory = a.directory || '?';
      const label = `${flag} ${fit(a.runtime, 7)} ${fit(a.title, titleWidth)} ${fitPath(directory, pathWidth)} ${age(a.activityAt || a.updatedAt).padStart(8)}`;
      return `{${color}-fg}${label}{/${color}-fg}`;
    }));
    const index = rows.findIndex(a => a.id === selectedId);
    list.select(index >= 0 ? index : 0);
    const counts = `${all.filter(a => a.runtime === 'WORKING').length} working  ·  ${all.filter(urgent).length} need attention  ·  ${all.filter(a => read.isRead(a)).length} read  ·  ${all.filter(a => a.runtime === 'UNKNOWN').length} unknown`;
    header.setContent(`{bold}{#7ab8ff-fg}CODEX MONITOR{/#7ab8ff-fg}{/bold}  ${counts}\n${clean(observer.health.message)}\nView: ${filter} · ${rows.length}/${all.length} sessions${query ? ` · search: ${clean(query)}` : ''}  |  ! attention  r read locally  ▶ working\n  STATUS  SESSION NAME${' '.repeat(Math.max(1, titleWidth - 12))}WORKING DIRECTORY / REPOSITORY    ACTIVITY`);
    renderDetail();
    footer.setContent(`↑↓/jk select · r mark read/unread · a all · n attention · w working · d read · / search · Esc clear · q quit\n${notice || 'Read only silences this item locally; new requests or turns return to attention. No Codex session is changed.'}`);
    rendering = false;
    screen.render();
  };
  const update = () => {
    try { read.reconcile(observer.agents); }
    catch (error) { notice = `Read state could not be saved: ${clean(String(error))}`; }
    render();
  };
  list.on('select item', () => { if (!rendering) { renderDetail(); screen.render(); } });
  screen.key('r', () => {
    if (searching) return;
    const agent = rows[(list as blessed.Widgets.ListElement & { selected: number }).selected];
    try {
      notice = agent && read.toggle(agent) ? `${clean(agent.title)}: ${read.isRead(agent) ? 'marked read locally' : 'returned to attention'}` : 'Select an attention item with a stable request or turn identity to mark read.';
    } catch (error) { notice = `Could not save read state: ${clean(String(error))}`; }
    render();
  });
  for (const [key, value] of Object.entries({ a: 'all', n: 'attention', w: 'working', d: 'read' } as const))
    screen.key(key, () => { if (!searching) { filter = value; notice = ''; render(); } });
  screen.key('escape', () => { if (!searching) { query = ''; filter = 'all'; render(); } });
  screen.key('/', () => {
    if (searching) return;
    searching = true;
    const input = blessed.textbox({ parent: screen, top: 3, left: 1, right: 1, height: 3, border: 'line', label: ' Search name / directory / id ', inputOnFocus: true, style: { fg: '#ffffff', bg: '#244d86' } });
    input.setValue(query);
    input.readInput((_error, value) => { if (typeof value === 'string') query = value; searching = false; input.destroy(); list.focus(); render(); });
  });
  const timer = setInterval(render, 1000);
  const close = () => {
    if (closed) return;
    closed = true; clearInterval(timer); observer.off('update', update); observer.stop(); screen.destroy();
    process.off('SIGTERM', onSignal); process.off('SIGINT', onSignal); process.off('exit', close);
  };
  const onSignal = () => { close(); process.exit(0); };
  screen.key('q', () => { if (!searching) { close(); process.exit(0); } });
  screen.key('C-c', () => { close(); process.exit(0); });
  process.once('SIGTERM', onSignal);
  process.once('SIGINT', onSignal);
  process.once('exit', close);
  screen.on('resize', render);
  observer.on('update', update);
  list.focus();
  render();
  return { screen, close };
}
